"""
Factory error SDK - Python side.

Dependency-free (standard library only); vendored into generated apps by the
deploy stage. Mirrors the Node SDK: capture what crashes, report it to the
sentinel, and never break the application by doing so.

Usage (wired automatically at deploy):

    import factory_error_sdk as factory_errors
    factory_errors.init()                      # reads FACTORY_APP_ID, SENTINEL_URL,
                                               # FACTORY_RELEASE, FACTORY_INGEST_KEY

    # Flask
    factory_errors.install_flask(app)
    # FastAPI / Starlette
    factory_errors.install_asgi(app)
    # Django: add factory_error_sdk.DjangoMiddleware to MIDDLEWARE
    # Anything else: call factory_errors.capture(exc) in your handler.
"""

import json
import os
import sys
import threading
import traceback
import urllib.error
import urllib.request

_state = {
    "app_id": None,
    "sentinel_url": None,
    "release": None,
    "ingest_key": None,
    "installed": False,
}


def init(app_id=None, sentinel_url=None, release=None, ingest_key=None):
    """Install global handlers. Safe to call more than once."""
    _state["app_id"] = app_id or os.environ.get("FACTORY_APP_ID")
    _state["sentinel_url"] = (sentinel_url or os.environ.get("SENTINEL_URL") or "").rstrip("/") or None
    _state["release"] = release or os.environ.get("FACTORY_RELEASE")
    # Server-side only. Never render this into a page or a client bundle.
    _state["ingest_key"] = ingest_key or os.environ.get("FACTORY_INGEST_KEY")

    if _state["installed"]:
        return
    _state["installed"] = True

    previous_hook = sys.excepthook

    def _excepthook(exc_type, exc, tb):
        capture(exc, {"origin": "excepthook"})
        previous_hook(exc_type, exc, tb)

    sys.excepthook = _excepthook

    # Exceptions escaping a thread are invisible to sys.excepthook (Python 3.8+).
    if hasattr(threading, "excepthook"):
        previous_thread_hook = threading.excepthook

        def _thread_excepthook(args):
            capture(args.exc_value, {"origin": "threading.excepthook", "thread": args.thread.name})
            previous_thread_hook(args)

        threading.excepthook = _thread_excepthook


def capture(exc, context=None):
    """Report an exception to the sentinel. Fire-and-forget; never raises."""
    try:
        if not _state["sentinel_url"] or not _state["app_id"]:
            return

        stack = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        event = {
            "appId": _state["app_id"],
            "release": _state["release"],
            "type": type(exc).__name__,
            "message": str(exc) or type(exc).__name__,
            "stack": stack[:8000],
            "context": context or {},
            "timestamp": _now(),
        }

        headers = {"Content-Type": "application/json"}
        if _state["ingest_key"]:
            headers["x-factory-key"] = _state["ingest_key"]

        request = urllib.request.Request(
            _state["sentinel_url"] + "/ingest",
            data=json.dumps(event).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        # Reporting must never hold up the crashing request.
        thread = threading.Thread(target=_send, args=(request,), daemon=True)
        thread.start()
    except Exception:  # noqa: BLE001 - telemetry must never break the app
        pass


def _send(request):
    try:
        urllib.request.urlopen(request, timeout=5).close()
    except Exception:  # noqa: BLE001
        pass


def _now():
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def _request_context(method=None, url=None, body=None):
    context = {"origin": "http"}
    if method:
        context["method"] = method
    if url:
        context["url"] = str(url)[:500]
    if body is not None:
        try:
            text = body if isinstance(body, str) else json.dumps(body)
            context["body"] = text[:2000]
        except Exception:  # noqa: BLE001
            pass
    return context


def install_flask(app):
    """Report every unhandled exception from a Flask app."""
    from flask import request  # imported lazily so the SDK stays dependency-free

    @app.errorhandler(Exception)
    def _factory_handler(exc):  # pragma: no cover - exercised in the generated app
        capture(exc, _request_context(request.method, request.url, _safe_json(request)))
        raise exc

    return app


def _safe_json(request):
    try:
        return request.get_json(silent=True)
    except Exception:  # noqa: BLE001
        return None


def install_asgi(app):
    """Wrap a FastAPI/Starlette app so unhandled exceptions are reported."""
    try:
        from starlette.middleware.base import BaseHTTPMiddleware
    except ImportError:  # pragma: no cover
        return install_asgi_raw(app)

    class _FactoryMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            try:
                return await call_next(request)
            except Exception as exc:  # noqa: BLE001
                capture(exc, _request_context(request.method, request.url))
                raise

    app.add_middleware(_FactoryMiddleware)
    return app


def install_asgi_raw(app):
    """Plain-ASGI fallback for frameworks without Starlette middleware."""

    async def wrapper(scope, receive, send):
        try:
            await app(scope, receive, send)
        except Exception as exc:  # noqa: BLE001
            capture(exc, _request_context(scope.get("method"), scope.get("path")))
            raise

    return wrapper


class DjangoMiddleware:
    """Add "factory_error_sdk.DjangoMiddleware" to MIDDLEWARE."""

    def __init__(self, get_response):
        self.get_response = get_response
        init()

    def __call__(self, request):
        return self.get_response(request)

    def process_exception(self, request, exception):  # pragma: no cover
        capture(exception, _request_context(request.method, request.build_absolute_uri()))
        return None
