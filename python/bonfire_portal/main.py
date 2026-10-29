from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .api import create_router
from .config import get_settings
from .domain.errors import DomainError
from .infrastructure.portal_database import PortalDatabase
from .infrastructure.kuscia import KusciaError
from .infrastructure.seatunnel import SeaTunnelError
from .application.context import PortalContext


@asynccontextmanager
async def lifespan(app: FastAPI):
    context: PortalContext = app.state.portal_context
    context.runtime.start()
    try:
        yield
    finally:
        await context.runtime.stop()
        await context.services.close()


def create_app() -> FastAPI:
    settings = get_settings()
    database = PortalDatabase(settings.sqlite_path)
    app = FastAPI(title="Bonfire Connector Portal", version="0.2.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.database = database
    app.state.connector_id = os.getenv("PORTAL_CONNECTOR_ID", "")

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        forwarded = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip().lower()
        secure = request.url.scheme == "https" or (settings.trust_proxy and forwarded == "https")
        if settings.require_https and not secure and request.url.path != "/health":
            return JSONResponse(status_code=426, content={"detail": "此服务仅允许通过 HTTPS 访问"})
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Content-Security-Policy"] = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
        if secure: response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        if request.url.path == "/portal/login" or request.url.path.startswith("/portal/onboarding"):
            response.headers["Cache-Control"] = "no-store"; response.headers["Pragma"] = "no-cache"
        return response

    app.state.portal_context = PortalContext.build(settings, database)
    app.include_router(create_router(settings, database, context=app.state.portal_context))

    @app.exception_handler(DomainError)
    async def domain_error(_request: Request, exc: DomainError):
        return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})

    @app.exception_handler(KusciaError)
    async def kuscia_error(_request: Request, exc: KusciaError):
        return JSONResponse(status_code=502, content={"detail": str(exc)})

    @app.exception_handler(SeaTunnelError)
    async def seatunnel_error(_request: Request, exc: SeaTunnelError):
        return JSONResponse(status_code=502, content={"detail": str(exc)})

    @app.get("/health")
    async def health():
        return {"code": 0, "message": "ok", "data": {"status": "healthy"}}

    if settings.web_dist.exists() and (settings.web_dist / "index.html").exists():
        app.mount("/assets", StaticFiles(directory=settings.web_dist / "assets"), name="assets")

        @app.get("/{path:path}")
        async def spa(path: str):
            if path.startswith("portal"):
                return JSONResponse(status_code=404, content={"detail": "Not Found"})
            candidate = settings.web_dist / path
            if candidate.is_file() and settings.web_dist in candidate.resolve().parents:
                return FileResponse(candidate)
            return FileResponse(settings.web_dist / "index.html")

    return app


app = create_app()
