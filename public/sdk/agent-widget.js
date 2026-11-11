/*!
 * Platform Widget SDK v0 — thin browser SDK.
 *
 * Embeds the platform's generic iframe widget (GET /embed/apps/:appId/widget)
 * and talks to it over postMessage. The browser holds ONLY a short-lived
 * widgetToken (obtained from the application's BFF via tokenProvider); the
 * AppKey never reaches the browser.
 *
 * Minimal API: init() → { open, close, destroy, updateContext, send }.
 * This SDK does NOT connect to the agent runtime directly and stores no
 * message content. Domain rendering (charts, etc.) is out of scope.
 */
(function () {
  "use strict";
  const PROTOCOL = "agent-widget";
  const VERSION = 1;

  function assert(cond, msg) { if (!cond) throw new Error("[AgentWidget] " + msg); }

  function init(options) {
    assert(options, "options required");
    assert(typeof options.platformUrl === "string", "platformUrl required");
    assert(typeof options.appId === "string", "appId required");
    assert(options.container, "container required (selector or HTMLElement)");
    assert(typeof options.tokenProvider === "function", "tokenProvider() required");

    const platformOrigin = new URL(options.platformUrl).origin;
    const platformBase = options.platformUrl.replace(/\/+$/, "");
    const containerEl =
      typeof options.container === "string"
        ? document.querySelector(options.container)
        : options.container;
    assert(containerEl, "container not found");

    const handlers = options.handlers || {};
    let context = options.context ? JSON.parse(JSON.stringify(options.context)) : {};
    let iframe = null;
    let ready = false;
    let cachedToken = null;
    let pageSessionId = null;        // captured from agent:ready (review P2)
    let pendingOut = [];             // outbound queued until agent:ready (review P2)

    function postToIframe(type, payload) {
      if (!iframe || !iframe.contentWindow) return;
      iframe.contentWindow.postMessage(
        Object.assign({ protocol: PROTOCOL, version: VERSION, type: type, pageSessionId: pageSessionId }, payload || {}),
        platformOrigin
      );
    }

    // send()/updateContext() must reach the iframe only AFTER agent:ready;
    // earlier calls are queued and flushed on ready through this same path.
    function queueOrPost(type, payload) {
      if (!ready) { pendingOut.push({ type: type, payload: payload }); return; }
      postToIframe(type, payload);
    }

    function onMessage(event) {
      if (event.origin !== platformOrigin) return; // only our own iframe
      const m = event.data;
      if (!m || m.protocol !== PROTOCOL) return;
      switch (m.type) {
        case "agent:ready":
          ready = true;
          pageSessionId = m.pageSessionId; // pin for all later SDK→iframe msgs
          // Boot first (carries pageSessionId + current context), then drain
          // anything queued before ready through the same send path.
          postToIframe("agent:boot", { context: context });
          var queued = pendingOut; pendingOut = [];
          queued.forEach(function (item) { postToIframe(item.type, item.payload); });
          if (typeof handlers.onReady === "function")
            handlers.onReady({ agentId: m.agentId, pageSessionId: m.pageSessionId });
          break;
        case "agent:resize":
          if (iframe && m.height) iframe.style.height = typeof m.height === "number" ? m.height + "px" : m.height;
          break;
        case "agent:state":
          break;
        case "agent:artifact":
          if (typeof handlers.onArtifact === "function")
            handlers.onArtifact({ type: m.artifactType, payload: m.artifact });
          break;
        case "agent:error":
          // Auth/connection failure: re-mint via tokenProvider and reload the
          // iframe so a refreshed widgetToken takes effect (tokenProvider must
          // be refresh-capable/idempotent — plan §3.2 / review P3).
          if (m.code === "auth" || m.code === "connection") reloadIframe();
          if (typeof handlers.onError === "function")
            handlers.onError({ code: m.code, message: m.message });
          break;
      }
    }

    async function ensureIframe() {
      if (iframe) return;
      // Always (re)fetch the token at iframe creation; tokenProvider is the
      // app's refresh-capable mint hook. Browsers never see the AppKey.
      cachedToken = await options.tokenProvider();
      assert(typeof cachedToken === "string" && cachedToken, "tokenProvider() must return a token string");

      iframe = document.createElement("iframe");
      iframe.src =
        platformBase +
        "/embed/apps/" + encodeURIComponent(options.appId) +
        "/widget?widgetToken=" + encodeURIComponent(cachedToken) +
        "#po=" + encodeURIComponent(location.origin); // parent-origin hint for the iframe
      iframe.setAttribute("allow", "clipboard-write");
      iframe.style.width = "100%";
      iframe.style.height = options.height || "520px";
      iframe.style.border = "0";
      iframe.style.borderRadius = "10px";
      iframe.style.display = "block";
      containerEl.appendChild(iframe);
      window.addEventListener("message", onMessage);
    }

    async function reloadIframe() {
      if (iframe) { iframe.remove(); iframe = null; ready = false; }
      await ensureIframe();
    }

    return {
      async open() {
        await ensureIframe();
        iframe.style.display = "block";
        if (ready) postToIframe("agent:open", {});
      },
      close() {
        if (iframe) { iframe.style.display = "none"; postToIframe("agent:close", {}); }
      },
      destroy() {
        if (iframe) postToIframe("agent:destroy", {});
        window.removeEventListener("message", onMessage);
        if (iframe) { iframe.remove(); iframe = null; }
        ready = false;
      },
      updateContext(ctx) {
        context = Object.assign({}, context, ctx || {});
        queueOrPost("agent:setContext", { context: context });
      },
      async send(content, opts) {
        assert(typeof content === "string", "send(content) must be a string");
        await ensureIframe();
        if (opts && opts.context) this.updateContext(opts.context);
        // One send queue: SDK.send routes through the iframe's WS, the same
        // path the iframe's own input box uses (plan §3.2 / review P3).
        queueOrPost("agent:send", { content: content });
      },
    };
  }

  window.AgentWidget = { init: init };
})();
