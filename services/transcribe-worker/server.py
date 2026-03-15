from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import subprocess
import tempfile
import time

import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile
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


def _get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        log.info("Loading model %s (compute_type=%s) …", WHISPER_MODEL, WHISPER_COMPUTE_TYPE)
        t0 = time.monotonic()
        _model = WhisperModel(
            WHISPER_MODEL,
            device="cpu",
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


def _transcribe_file(wav_path: str) -> tuple[str, float]:
    model = _get_model()
    segments, info = model.transcribe(
        wav_path,
        beam_size=WHISPER_BEAM_SIZE,
        language=WHISPER_LANGUAGE or None,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
    )
    parts: list[str] = []
    for seg in segments:
        parts.append(seg.text.strip())
    text = " ".join(parts).strip()
    return text, info.duration


app = FastAPI(title="Transcribe Worker")


@app.get("/health")
async def health():
    return {"status": "ok", "model": WHISPER_MODEL}


@app.post("/transcribe")
async def transcribe(file: UploadFile):
    if not file.filename:
        raise HTTPException(400, "No file provided")

    async with _semaphore:
        return await _run_transcription(file)


async def _run_transcription(file: UploadFile) -> JSONResponse:
    with tempfile.TemporaryDirectory(prefix="transcribe-") as tmp:
        raw_path = os.path.join(tmp, file.filename or "input.bin")
        wav_path = os.path.join(tmp, "audio.wav")

        data = await file.read()
        file_hash = hashlib.sha256(data).hexdigest()[:16]

        with open(raw_path, "wb") as f:
            f.write(data)

        log.info(
            "Received %s (%.1f MB, hash=%s)",
            file.filename, len(data) / 1024 / 1024, file_hash,
        )

        loop = asyncio.get_running_loop()

        t0 = time.monotonic()
        await loop.run_in_executor(None, _convert_to_wav16k, raw_path, wav_path)
        convert_sec = time.monotonic() - t0

        t1 = time.monotonic()
        text, audio_duration = await loop.run_in_executor(None, _transcribe_file, wav_path)
        transcribe_sec = time.monotonic() - t1

        total_sec = time.monotonic() - t0

    if not text:
        raise HTTPException(422, "Не удалось распознать речь в аудио.")

    log.info(
        "Done %s: audio=%.0fs, convert=%.1fs, transcribe=%.1fs, total=%.1fs, ratio=%.2fx",
        file.filename, audio_duration, convert_sec, transcribe_sec, total_sec,
        total_sec / audio_duration if audio_duration > 0 else 0,
    )

    return JSONResponse({
        "text": text,
        "audio_duration_sec": round(audio_duration, 1),
        "processing_time_sec": round(total_sec, 1),
    })


if __name__ == "__main__":
    _get_model()
    uvicorn.run(app, host="0.0.0.0", port=8070)
