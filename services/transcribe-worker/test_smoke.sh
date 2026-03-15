#!/bin/bash
# Smoke test for transcribe-worker.
# Usage: ./test_smoke.sh [audio_file]
# If no file provided, generates a short silent WAV for a basic health check.

set -e

WORKER_URL="${TRANSCRIPTION_WORKER_URL:-http://localhost:8070}"

echo "=== Health check ==="
curl -s "$WORKER_URL/health" | python3 -m json.tool
echo ""

if [ -n "$1" ]; then
  FILE="$1"
else
  echo "No test file provided — generating a 5s silent WAV…"
  FILE="/tmp/test_silence.wav"
  ffmpeg -y -f lavfi -i anullsrc=r=16000:cl=mono -t 5 "$FILE" 2>/dev/null
fi

echo "=== Transcribing: $FILE ==="
time curl -s -X POST "$WORKER_URL/transcribe" \
  -F "file=@$FILE" | python3 -m json.tool

echo ""
echo "=== Done ==="
