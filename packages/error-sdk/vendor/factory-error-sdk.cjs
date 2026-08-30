/**
 * Factory error SDK - global error capture for self-healing.
 * Dependency-free CommonJS; vendored into generated apps by the deploy stage.
 *
 * Usage (wired automatically at deploy):
 *   const factoryErrors = require("./factory-error-sdk.cjs");
 *   factoryErrors.init(); // reads FACTORY_APP_ID, SENTINEL_URL, FACTORY_RELEASE
 *   ...
 *   app.use(factoryErrors.expressErrorHandler()); // AFTER all routes
 */
"use strict";

const state = {
  appId: null,
  sentinelUrl: null,
  release: null,
  installed: false,
};

function init(opts) {
  opts = opts || {};
  state.appId = opts.appId || process.env.FACTORY_APP_ID || null;
  state.sentinelUrl = (opts.sentinelUrl || process.env.SENTINEL_URL || "").replace(/\/$/, "") || null;
  state.release = opts.release || process.env.FACTORY_RELEASE || null;
  if (state.installed) return;
  state.installed = true;

  process.on("uncaughtException", (err) => {
    console.error("[factory-error-sdk] uncaughtException:", err);
    capture(err, { origin: "uncaughtException" });
  });
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    console.error("[factory-error-sdk] unhandledRejection:", err);
    capture(err, { origin: "unhandledRejection" });
  });
}

/** Report an error to the sentinel. Fire-and-forget; never throws. */
function capture(err, context) {
  try {
    if (!state.sentinelUrl || !state.appId) return;
    const event = {
      appId: state.appId,
      release: state.release || undefined,
      type: (err && err.name) || "Error",
      message: String((err && err.message) || err),
      stack: (err && err.stack) || undefined,
      context: context || {},
      timestamp: new Date().toISOString(),
    };
    fetch(state.sentinelUrl + "/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    }).catch(() => {});
  } catch {
    /* never break the app over telemetry */
  }
}

/** Express error-handling middleware; add AFTER all routes. */
function expressErrorHandler() {
  return function factoryErrorHandler(err, req, res, next) {
    capture(err, {
      origin: "express",
      method: req && req.method,
      url: req && req.originalUrl,
      body: safeBody(req),
    });
    if (res.headersSent) return next(err);
    res.status(err && err.status ? err.status : 500).json({ error: "Internal Server Error" });
  };
}

function safeBody(req) {
  try {
    const raw = req && req.body;
    if (!raw) return undefined;
    const s = JSON.stringify(raw);
    return s.length > 2000 ? s.slice(0, 2000) : JSON.parse(s);
  } catch {
    return undefined;
  }
}

module.exports = { init, capture, expressErrorHandler };
