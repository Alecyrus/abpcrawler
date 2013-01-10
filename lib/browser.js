//-------------------------------------------------------
// Tabbed_Browser
//-------------------------------------------------------
/**
 * A single OS-level window of a multiple-tab Firefox browser. This is the object referred to by the global 'gBrowser'.
 *
 * @param {Window} window
 * @param {Integer} max_requests
 *      The maximum number of simultaneous requests this object may have.
 * @constructor
 */
var Tabbed_Browser = exports.Tabbed_Browser = function( window, max_requests )
{
    /**
     * Browser window through which we access the global browser object.
     * @type {Window}
     */
    this.window = window;

    /**
     * A browser object that can hold multiple individual tabbed browser panes.
     */
    this.tabbed_browser = this.window.gBrowser;

    /**
     * The current number of pending requests in child tabs of this object.
     * @type {Number}
     */
    this.n_requests = 0;

    /**
     * The maximum number of simultaneous requests this object may have.
     * @type {Number}
     */
    this.max_requests = max_requests;
};

/**
 * Predicate "is there an open request slot?"
 */
Tabbed_Browser.prototype.available = function()
{
    return this.n_requests < this.max_requests;
};

/**
 * @param {Boolean} [leave_open=false]
 *      Leave the tab open in the browser after closing the present object
 */
Tabbed_Browser.prototype.make_tab = function( leave_open )
{
    return new Browser_Tab( this, leave_open );
};

/**
 * Release resources held by this object. This includes event handlers.
 */
Tabbed_Browser.prototype.close = function()
{
};

//-------------------------------------------------------
// Browser_Tab
//-------------------------------------------------------
/**
 * A single browser tab that can asynchronously load a web page.
 *
 * @param {Tabbed_Browser} parent
 * @param {Boolean} [leave_open=false]
 *      Leave the tab open in the browser after closing the present object
 * @constructor
 */
var Browser_Tab = exports.Browser_Tab = function( parent, leave_open )
{
    /**
     * The parent tabbed browser in whose tab set this tab is a member.
     * @type {Tabbed_Browser}
     */
    this.parent = parent;

    /**
     * Leave the tab open in the browser after the crawler exits. The reason to do this is to allow manual inspection
     * of the window as the crawler loaded it.
     * <p/>
     * It's necessary to call 'close()' on any instance of this object in order to ensure event handlers are released.
     * This is true whether or not the tab remains open afterwards.
     *
     * @type {Boolean}
     */
    this.leave_open = (arguments.length >= 2) ? leave_open : true;

    /**
     * A browser object that can hold multiple individual tabbed browser panes.
     */
    this.tabbed_browser = this.parent.tabbed_browser;

    /**
     * Our tab within the tabbed browser. This is the "external" view of browser pane, the one that allows us to
     * control loading. The tab must have a URL associated with it, so it's not displayed at the outset
     * <p/>
     * FUTURE: Might it be useful to load the tab with a empty page but descriptive title at construction time?
     */
    this.tab = null;

    /**
     * Bound listener function for progress events. This function is null if has not been added as a progress-listener.
     * @type {*}
     */
    this.listener = null;

    /**
     * The function to be run upon completion of an asynchronous load.
     * @type {Function}
     */
    this.finally_f = null;

    /**
     * The function to be run if there's an exceptional termination to an asynchronous load.
     * @type {Function}
     */
    this.catch_f = null;

    /**
     * STATE
     */
    this.state = Browser_Tab.STATE.CREATED;
};

Browser_Tab.STATE = {
    // Initial state
    CREATED: 0,
    // Nonterminal states
    LOADING: 1,
    // Terminal states
    DISPLAYED: 2,
    ERROR: 3,
    CLOSED: 4
};

/**
 * Predicate "is the Browser_Tab in an initial state for its page load?"
 *
 * @return {Boolean}
 */
Browser_Tab.prototype.in_initial_state = function()
{
    return this.state == Browser_Tab.STATE.CREATED;
};

/**
 * Predicate "is this object in a final state for its page load?"
 * <p/>
 * The CLOSED state is considered a final state, although it's present to implement the moral equivalent of a
 * destructor correctly.
 *
 * @return {Boolean}
 */
Browser_Tab.prototype.in_final_state = function()
{
    return this.state >= Browser_Tab.STATE.DISPLAYED;
};

/**
 * Close function destroys our allocated host resources, such as tabs, listeners, requests, etc.
 */
Browser_Tab.prototype.close = function()
{
    if ( this.state == Browser_Tab.STATE.CLOSED )
        return;

    if ( this.listener )
    {
        this.tabbed_browser.removeTabsProgressListener( this.listener );
        this.listener = null;
    }
    if ( this.tab )
    {
        if ( !this.leave_open )
        {
            this.tabbed_browser.removeTab( this.tab );
        }
        this.tab = null;
    }
    /*
     * Cancel any pending page load here.
     */
    this.state = Browser_Tab.STATE.CLOSED;
};

/**
 * Return an asynchronous action that loads a target into a new tab.
 */
Browser_Tab.prototype.load = function( target )
{
    return {
        go: function( finally_f, catch_f )
        {
            this.finally_f = finally_f;
            this.catch_f = catch_f;
            this._show( target );
        }.bind( this )
    };
};

/**
 * Show the tab by loading a URL target into it.
 *
 * @param {String} target
 */
Browser_Tab.prototype._show = function( target )
{
    try
    {
        // Add the listener first, in case the STOP event happens immediately upon adding the tab.
        this.listener = { onStateChange: this._progress.bind( this ) };
        this.tabbed_browser.addTabsProgressListener( this.listener );
        this.tab = this.tabbed_browser.addTab( target );
        this.browser = this.tabbed_browser.getBrowserForTab( this.tab );
    }
    catch ( e )
    {
        this.state = Browser_Tab.STATE.ERROR;
        Cu.reportError( "Unexpected exception in Browser_Tab.show(): " + e.toString() );
        if ( this.catch_f ) this.catch_f( e );
        if ( this.finally_f ) this.finally_f( false );
    }
};

/**
 * Progress event handler. It looks only for STOP states on the present tab. When that happens, it determines the
 * success status and calls the landing function.
 *
 * @param {*} browser
 * @param {nsIWebProgress} controller
 *      The control object for progress monitoring that dispatches the event.
 * @param {nsIRequest} browse_request
 *      The request object generated by the called to addTab(), which loads a page.
 * @param state
 *      The progress state, represented as flags.
 * @param stop_status
 *      Status code for success or failure if the argument state is a STOP state.
 */
Browser_Tab.prototype._progress = function( browser, controller, browse_request, state, stop_status )
{
    /*
     * This check ensures that we only call 'finally_f' once. The browser will send multiple STOP events when the user
     * focuses on a tab window by clicking on its tab. Since we set a final state if we accept the event below, checking
     * for a final state ensures that we act idempotently.
     *
     * This check also forestalls a race condition where a request completes and schedules a progress event while we are
     * closing the object.
     */
    if ( this.in_final_state() )
        return;

    /*
     * Filter out events on other tabs.
     * <p/>
     * Note that this filtering algorithm requires N^2 dispatching progress events, since each tab has its own
     * listener but receives events for each tab. It would be better for code hygiene and resilience against host
     * defects to have a parent class with a single, persistent event handler that dispatched to us here.
     */
    if ( this.browser !== browser )
        return;

    /*
     * We only care about STOP states. We're not tracking redirects, which is one of the progress states possible.
     * We may want to in the future, though, in case redirect behavior is involved with ad delivery in some way.
     */
    //noinspection JSBitwiseOperatorUsage
    if ( !(state & Ci.nsIWebProgressListener.STATE_STOP) )
        return;

    var success = (stop_status == 0 );
    if ( success )
    {
        this.state = Browser_Tab.STATE.DISPLAYED;
    }
    else
    {
        this.state = Browser_Tab.STATE.ERROR;
        /**
         * This argument is an XPCOM 'nsresult' value. It could be examined if the cause of the failure to load needs
         * to be diagnosed. For example, NS_ERROR_OFFLINE would be useful for suspending operation of the crawler while
         * internet connectivity comes back. NS_ERROR_MALFORMED_URI would be useful for notifing the user of a typo.
         */
        this.error_code = stop_status;
    }
    if ( this.finally_f ) this.finally_f( success );
};