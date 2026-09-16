"""Polza Reports — FastAPI service.

Stateless HTTP wrapper around the Coldy scraper and Trigga CSV parser. The
Portal Next.js layer is the only client; it sits in the same Docker network
and calls us over plain HTTP. No auth here — the service must never be exposed
publicly (no port mapping in docker-compose).

Endpoints:
  GET  /health                — liveness probe
  POST /reports/coldy         — Server-Sent Events: progress + final xlsx (base64)
  POST /reports/trigga        — multipart CSV upload → xlsx in response body

All credentials arrive in the request body and live in-memory only.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import traceback
from typing import AsyncIterator

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from formatter import format_xlsx_report
from models import ColdyCredentials
from scraper import scrape_all
from trigga import parse_trigga_csv

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("polza-reports")

app = FastAPI(title="Polza Reports", version="1.0.0")


# ── Schemas ──────────────────────────────────────────────────────────────────


class ColdyRequest(BaseModel):
    email: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)
    url: str = Field(default="https://app.coldy.ai")
    detailed: bool = True
    include_created: bool = True
    include_base_left: bool = True


# ── Health ───────────────────────────────────────────────────────────────────


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


# ── SSE helpers ──────────────────────────────────────────────────────────────


def _sse(event: dict) -> str:
    """Serialize one Server-Sent Event line."""
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


# ── Coldy report (SSE) ───────────────────────────────────────────────────────


@app.post("/reports/coldy")
async def coldy_report(req: ColdyRequest) -> StreamingResponse:
    """Scrape Coldy and stream progress; final event carries the xlsx in base64.

    Event shapes (always JSON in `data:` payload):
      {"type": "start"}
      {"type": "progress", "phase": "login"}
      {"type": "progress", "phase": "campaigns_list", "total": N}
      {"type": "progress", "phase": "analytics", "current": i, "total": N, "campaign_name": "..."}
      {"type": "progress", "phase": "formatting"}
      {"type": "result", "xlsx_b64": "...", "campaigns_count": N}
      {"type": "error", "message": "..."}
    """
    queue: asyncio.Queue[dict] = asyncio.Queue()
    done = asyncio.Event()

    async def on_progress(event: dict) -> None:
        await queue.put({"type": "progress", **event})

    async def run_scrape() -> None:
        try:
            credentials = ColdyCredentials(
                email=req.email,
                password=req.password,
                url=req.url.rstrip("/"),
            )
            campaigns = await scrape_all(
                detailed=req.detailed,
                credentials=credentials,
                on_progress=on_progress,
            )

            await queue.put({"type": "progress", "phase": "formatting"})
            xlsx_bytes = format_xlsx_report(
                campaigns,
                include_created=req.include_created,
                include_base_left=req.include_base_left,
            )
            await queue.put({
                "type": "result",
                "xlsx_b64": base64.b64encode(xlsx_bytes).decode("ascii"),
                "campaigns_count": len(campaigns),
            })
        except Exception as exc:  # noqa: BLE001 — surface any error to the client
            logger.error("Coldy scrape failed: %s\n%s", exc, traceback.format_exc())
            await queue.put({"type": "error", "message": str(exc) or "Scrape failed"})
        finally:
            done.set()

    async def event_stream() -> AsyncIterator[str]:
        yield _sse({"type": "start"})
        task = asyncio.create_task(run_scrape())
        try:
            while True:
                if done.is_set() and queue.empty():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=1.0)
                    yield _sse(event)
                except asyncio.TimeoutError:
                    # Heartbeat — keeps proxies from closing the connection.
                    yield ": keep-alive\n\n"
        finally:
            if not task.done():
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",  # disable nginx buffering if reverse-proxied
        },
    )


# ── Trigga report (sync multipart) ───────────────────────────────────────────


@app.post("/reports/trigga")
async def trigga_report(
    file: UploadFile = File(...),
    include_created: bool = Form(default=False),
    include_base_left: bool = Form(default=False),
) -> Response:
    """Parse a Trigga CSV upload and return the rendered xlsx synchronously."""
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty CSV file")

    try:
        campaigns = parse_trigga_csv(raw)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to parse Trigga CSV")
        raise HTTPException(status_code=400, detail=f"Не удалось разобрать CSV: {exc}") from exc

    if not campaigns:
        raise HTTPException(status_code=400, detail="В CSV не найдено ни одной кампании")

    xlsx_bytes = format_xlsx_report(
        campaigns,
        include_created=include_created,
        include_base_left=include_base_left,
    )

    return Response(
        content=xlsx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "X-Campaigns-Count": str(len(campaigns)),
        },
    )
