# polza-reports

Stateless FastAPI service that wraps the Coldy scraper + Trigga CSV parser
from `polza_bot` and exposes them to the Portal as HTTP endpoints. It runs
in the internal Docker network only and never accepts traffic from outside.

## Endpoints

| Method | Path             | Body                                              | Returns                                            |
|--------|------------------|---------------------------------------------------|----------------------------------------------------|
| GET    | `/health`        | —                                                 | `{"status":"ok"}`                                  |
| POST   | `/reports/coldy` | JSON `{email,password,url,detailed,...}`          | `text/event-stream` with progress + final `xlsx_b64` |
| POST   | `/reports/trigga`| multipart `file=<csv>`, `include_created`, etc.   | `application/vnd…spreadsheetml.sheet` bytes        |

## SSE event shapes

```
{"type":"start"}
{"type":"progress","phase":"login"}
{"type":"progress","phase":"campaigns_list","total":N}
{"type":"progress","phase":"analytics","current":i,"total":N,"campaign_name":"..."}
{"type":"progress","phase":"formatting"}
{"type":"result","xlsx_b64":"<base64>","campaigns_count":N}
{"type":"error","message":"..."}
```

## Local dev

```bash
docker build -t polza-reports .
docker run --rm -p 8000:8000 polza-reports
curl http://localhost:8000/health
```

## Why a separate service

The Coldy scrape uses Playwright/Chromium and lots of Coldy-specific selector
fallbacks. Keeping it Python + isolated in its own container means:

- No Chromium bloat in the main worker image.
- Coldy UI breakage requires only this service to be rebuilt.
- No risk of regression when rewriting battle-tested selectors to TS.

Source for the underlying logic: `G:\PycharmProjects\polza_bot` (Telegram bot).
