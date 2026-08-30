/**
 * Factory error SDK - browser side.
 * Served by the app (e.g. at /factory-error-sdk.js) and included from its HTML:
 *   <script src="/factory-error-sdk.js" data-app-id="..."></script>
 *
 * Always posts same-origin to /__factory_error, where the app's own server adds
 * the ingest key and forwards to the sentinel (see browserProxy() in the CJS SDK).
 * Reporting straight to the sentinel from a page is deliberately not supported:
 * it would mean shipping the key to every visitor, and it would need CORS.
 */
(function () {
  "use strict";
  var script = document.currentScript;
  var appId = (script && script.getAttribute("data-app-id")) || "";
  var release = (script && script.getAttribute("data-release")) || "";
  var endpoint = "/__factory_error";
  var sent = Object.create(null);

  function report(type, message, stack, extra) {
    try {
      // Collapse identical browser errors client-side too: a render loop must not
      // flood the sentinel with thousands of copies of one bug.
      var key = type + "|" + message + "|" + String(stack).slice(0, 200);
      if (sent[key]) return;
      sent[key] = true;

      var body = JSON.stringify({
        appId: appId,
        release: release || undefined,
        type: type || "Error",
        message: String(message).slice(0, 1000),
        stack: stack ? String(stack).slice(0, 8000) : undefined,
        context: Object.assign({ origin: "browser", url: location.href, userAgent: navigator.userAgent }, extra || {}),
        timestamp: new Date().toISOString(),
      });

      // sendBeacon survives the page unloading after a fatal error; fetch is the fallback.
      if (navigator.sendBeacon) {
        navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" }));
      } else {
        fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: body, keepalive: true })
          ["catch"](function () {});
      }
    } catch (e) {
      /* telemetry must never break the page */
    }
  }

  window.addEventListener("error", function (event) {
    var err = event.error;
    report(
      (err && err.name) || "Error",
      (err && err.message) || event.message,
      err && err.stack,
      { file: event.filename, line: event.lineno, column: event.colno },
    );
  });

  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    report(
      (reason && reason.name) || "UnhandledRejection",
      (reason && reason.message) || String(reason),
      reason && reason.stack,
      {},
    );
  });

  window.__factoryReportError = function (err, extra) {
    report((err && err.name) || "Error", (err && err.message) || String(err), err && err.stack, extra);
  };
})();
