# Factory error-reporting contract

Self-healing only works if runtime errors reach the sentinel. Node and Python get a
vendored SDK; every other language implements this contract directly. It is small
on purpose — one HTTP POST.

## The request

```
POST  $SENTINEL_URL/ingest
Content-Type: application/json
x-factory-key: $FACTORY_INGEST_KEY
```

```json
{
  "appId":     "value of the FACTORY_APP_ID environment variable",
  "release":   "value of FACTORY_RELEASE, or omitted",
  "type":      "exception class name, e.g. NullPointerException",
  "message":   "the error message, 1000 chars max",
  "stack":     "the full stack trace as text, 8000 chars max",
  "context":   { "origin": "http", "method": "GET", "url": "/api/things/9" },
  "timestamp": "2026-08-30T21:15:00Z"
}
```

`appId` and `message` are required; everything else is optional but makes healing
better. Responses: `200` accepted, `401` bad or missing key, `429` rate limited.

## Environment

The factory sets these when it starts your app. Read them at startup.

| variable | meaning |
| --- | --- |
| `FACTORY_APP_ID` | identifies this app to the sentinel |
| `SENTINEL_URL` | base URL of the sentinel |
| `FACTORY_INGEST_KEY` | shared secret for the `x-factory-key` header |
| `FACTORY_RELEASE` | git sha currently deployed |

**`FACTORY_INGEST_KEY` is server-side only.** Never render it into a page, a
client bundle, a template, or a log. If the app has a browser frontend, have the
browser POST errors to a same-origin route on your own server, and let that route
add the key and forward the report.

## What to hook

Report from **both** levels — they catch different failures:

1. **Framework level** — the top-level error handler, exception filter, panic
   recovery middleware, or equivalent. Catches errors during a request, and lets
   you attach the method and path.
2. **Process level** — the unhandled-exception or panic hook, plus whatever your
   runtime uses for errors escaping a background task or goroutine. Catches the
   crashes that never reach a request handler.

## Rules

- **Fire and forget.** Reporting must never change how the app behaves. Wrap it so
  a network failure, a bad response, or a timeout is swallowed silently.
- **Do not block the request.** Send asynchronously, or with a short timeout.
- **Re-raise after reporting.** Capturing an error must not accidentally handle it.
- **Do not batch or retry.** Identical errors are deduplicated by the sentinel;
  duplicates are cheap and a lost report is not worth a retry queue.
- **Keep the stack trace intact.** It is what fingerprinting uses to tell one bug
  from another, so send the real multi-line trace rather than a summary.

## Verifying it

After wiring, prove it works rather than assuming:

1. Start the app with the environment above set.
2. Trigger a real error — an endpoint that raises on purpose is fine, as long as
   you remove it afterwards.
3. Confirm the sentinel returned `200` and reported an `incidentId`.

An integration that is never verified tends to be an integration that never fires,
and a factory that cannot see errors cannot heal anything.
