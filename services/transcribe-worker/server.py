from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import subprocess
import tempfile
import time
import uuid
from threading import Lock
from typing import Literal, TypedDict

import uvicorn
from fastapi import FastAPI, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("transcribe-worker")

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
WHISPER_BEAM_SIZE = int(os.getenv("WHISPER_BEAM_SIZE", "1"))
WHISPER_LANGUAGE = os.getenv("WHISPER_LANGUAGE", "")
MAX_CONCURRENT = int(os.getenv("MAX_CONCURRENT", "1"))

_semaphore = asyncio.Semaphore(MAX_CONCURRENT)
_model = None
PROGRESS_TTL_SECONDS = int(os.getenv("PROGRESS_TTL_SECONDS", "3600"))


class ProgressState(TypedDict):
    job_id: str
    stage: Literal["queued", "converting", "transcribing", "done", "cancelled", "error"]
    progress_percent: int
    processed_seconds: float | None
    audio_duration_seconds: float | None
    error: str | None
    updated_at: float


_progress_by_job: dict[str, ProgressState] = {}
_progress_lock = Lock()
_cancelled_jobs: set[str] = set()


def _cleanup_progress(now_ts: float | None = None) -> None:
    now = now_ts if now_ts is not None else time.time()
    stale_ids = [
        job_id
        for job_id, state in _progress_by_job.items()
        if now - state["updated_at"] > PROGRESS_TTL_SECONDS
    ]
    for job_id in stale_ids:
        _progress_by_job.pop(job_id, None)


def _set_progress(
    job_id: str,
    stage: Literal["queued", "converting", "transcribing", "done", "cancelled", "error"],
    progress_percent: int,
    *,
    processed_seconds: float | None = None,
    audio_duration_seconds: float | None = None,
    error: str | None = None,
) -> None:
    now = time.time()
    state: ProgressState = {
        "job_id": job_id,
        "stage": stage,
        "progress_percent": max(0, min(100, int(progress_percent))),
        "processed_seconds": processed_seconds,
        "audio_duration_seconds": audio_duration_seconds,
        "error": error,
        "updated_at": now,
    }
    with _progress_lock:
        _cleanup_progress(now)
        _progress_by_job[job_id] = state


def _get_progress(job_id: str) -> ProgressState | None:
    now = time.time()
    with _progress_lock:
        _cleanup_progress(now)
        return _progress_by_job.get(job_id)


def _mark_cancelled(job_id: str) -> None:
    with _progress_lock:
        _cancelled_jobs.add(job_id)


def _is_cancelled(job_id: str) -> bool:
    with _progress_lock:
        return job_id in _cancelled_jobs


class TranscriptionCancelledError(Exception):
    pass


def _get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        log.info("Loading model %s (compute_type=%s) …", WHISPER_MODEL, WHISPER_COMPUTE_TYPE)
        t0 = time.monotonic()
        _model = WhisperModel(
            WHISPER_MODEL,
            device=os.getenv("WHISPER_DEVICE", "auto"),
            compute_type=WHISPER_COMPUTE_TYPE,
            cpu_threads=int(os.getenv("CPU_THREADS", "0")) or os.cpu_count() or 4,
        )
        log.info("Model loaded in %.1fs", time.monotonic() - t0)
    return _model


def _convert_to_wav16k(src: str, dst: str) -> None:
    cmd = [
        "ffmpeg", "-y", "-i", src,
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        dst,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr[:500]}")


def _transcribe_file(wav_path: str, job_id: str) -> tuple[str, float]:
    if _is_cancelled(job_id):
        raise TranscriptionCancelledError("Transcription cancelled by user")

    model = _get_model()
    segments, info = model.transcribe(
        wav_path,
        beam_size=WHISPER_BEAM_SIZE,
        language=WHISPER_LANGUAGE or None,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
    )
    parts: list[str] = []
    audio_duration = float(getattr(info, "duration", 0.0) or 0.0)
    for seg in segments:
        if _is_cancelled(job_id):
            raise TranscriptionCancelledError("Transcription cancelled by user")
        parts.append(seg.text.strip())
        processed_seconds = float(getattr(seg, "end", 0.0) or 0.0)
        if audio_duration > 0:
            ratio = max(0.0, min(1.0, processed_seconds / audio_duration))
            progress_percent = min(99, 15 + int(ratio * 84))
            _set_progress(
                job_id,
                "transcribing",
                progress_percent,
                processed_seconds=processed_seconds,
                audio_duration_seconds=audio_duration,
            )
    text = " ".join(parts).strip()
    return text, audio_duration


app = FastAPI(title="Transcribe Worker")


@app.get("/health")
async def health():
    return {"status": "ok", "model": WHISPER_MODEL}


@app.post("/transcribe")
async def transcribe(file: UploadFile, x_transcribe_job_id: str | None = Header(default=None)):
    if not file.filename:
        raise HTTPException(400, "No file provided")

    job_id = (x_transcribe_job_id or "").strip() or str(uuid.uuid4())
    _set_progress(job_id, "queued", 0)

    async with _semaphore:
        return await _run_transcription(file, job_id)


@app.get("/progress/{job_id}")
async def get_progress(job_id: str):
    state = _get_progress(job_id)
    if state is None:
        raise HTTPException(404, "Progress not found")
    return JSONResponse(state)


@app.post("/cancel/{job_id}")
async def cancel_transcription(job_id: str):
    _mark_cancelled(job_id)
    _set_progress(job_id, "cancelled", 100, error="Transcription cancelled by user")
    return JSONResponse({"ok": True, "job_id": job_id, "message": "Cancel requested"})


async def _run_transcription(file: UploadFile, job_id: str) -> JSONResponse:
    try:
        if _is_cancelled(job_id):
            raise TranscriptionCancelledError("Transcription cancelled by user")

        with tempfile.TemporaryDirectory(prefix="transcribe-") as tmp:
            raw_path = os.path.join(tmp, file.filename or "input.bin")
            wav_path = os.path.join(tmp, "audio.wav")

            data = await file.read()
            file_hash = hashlib.sha256(data).hexdigest()[:16]

            with open(raw_path, "wb") as f:
                f.write(data)

            log.info(
                "Received %s (%.1f MB, hash=%s, job_id=%s)",
                file.filename, len(data) / 1024 / 1024, file_hash, job_id,
            )

            loop = asyncio.get_running_loop()

            t0 = time.monotonic()
            _set_progress(job_id, "converting", 5)
            await loop.run_in_executor(None, _convert_to_wav16k, raw_path, wav_path)
            convert_sec = time.monotonic() - t0

            t1 = time.monotonic()
            if _is_cancelled(job_id):
                raise TranscriptionCancelledError("Transcription cancelled by user")
            _set_progress(job_id, "transcribing", 15, processed_seconds=0.0)
            text, audio_duration = await loop.run_in_executor(None, _transcribe_file, wav_path, job_id)
            transcribe_sec = time.monotonic() - t1

            total_sec = time.monotonic() - t0

        if not text:
            raise HTTPException(422, "Не удалось распознать речь в аудио.")

        _set_progress(
            job_id,
            "done",
            100,
            processed_seconds=audio_duration,
            audio_duration_seconds=audio_duration,
        )

        log.info(
            "Done %s: audio=%.0fs, convert=%.1fs, transcribe=%.1fs, total=%.1fs, ratio=%.2fx, job_id=%s",
            file.filename, audio_duration, convert_sec, transcribe_sec, total_sec,
            total_sec / audio_duration if audio_duration > 0 else 0, job_id,
        )

        return JSONResponse({
            "text": text,
            "audio_duration_sec": round(audio_duration, 1),
            "processing_time_sec": round(total_sec, 1),
            "job_id": job_id,
        })
    except TranscriptionCancelledError as err:
        _set_progress(job_id, "cancelled", 100, error=str(err))
        raise HTTPException(409, str(err))
    except HTTPException as err:
        _set_progress(job_id, "error", 100, error=str(err.detail))
        raise
    except Exception as err:
        _set_progress(job_id, "error", 100, error=str(err))
        raise



if __name__ == "__main__":
    _get_model()
    uvicorn.run(app, host="0.0.0.0", port=8070)
