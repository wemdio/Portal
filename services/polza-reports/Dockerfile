# Polza Reports — FastAPI wrapper around Coldy/Trigga report builders.
# Uses the official Playwright image so chromium is preinstalled.
FROM mcr.microsoft.com/playwright/python:v1.44.0-jammy

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY models.py scraper.py formatter.py trigga.py main.py ./

EXPOSE 8000

# Single worker — long-running browser sessions, in-process state is fine.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--log-level", "info"]
