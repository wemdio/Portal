import asyncio
import hashlib
import json
import os
import queue
import time
import threading
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from yandex_parser import Organization, ProxySettings, YandexMapsParser


app = FastAPI()
YANDEXMAPS_CONCURRENCY = int(os.environ.get("YANDEXMAPS_CONCURRENCY", "2"))
_REQUEST_SEMAPHORE = asyncio.Semaphore(YANDEXMAPS_CONCURRENCY)
COLLECT_TIMEOUT_SEC = int(os.environ.get("YANDEXMAPS_COLLECT_TIMEOUT_SEC", "540"))
PARSE_TIMEOUT_SEC = int(os.environ.get("YANDEXMAPS_PARSE_TIMEOUT_SEC", "540"))
BROWSER_IDLE_TIMEOUT_SEC = int(os.environ.get("YANDEXMAPS_BROWSER_IDLE_SEC", "300"))


# ---------------------------------------------------------------------------
# Browser instance pool — reuse Chromium between requests with matching proxy
# ---------------------------------------------------------------------------

class _BrowserPool:
  """Thread-safe pool of YandexMapsParser instances keyed by proxy hash."""

  def __init__(self, idle_timeout: int = BROWSER_IDLE_TIMEOUT_SEC):
    self._lock = threading.Lock()
    self._idle: dict[str, list[tuple[YandexMapsParser, float]]] = {}
    self._idle_timeout = idle_timeout

  @staticmethod
  def _proxy_key(proxy_settings: ProxySettings) -> str:
    if not proxy_settings.enabled:
      return "no-proxy"
    raw = f"{proxy_settings.protocol}:{proxy_settings.host}:{proxy_settings.port}:{proxy_settings.username}"
    return hashlib.md5(raw.encode()).hexdigest()

  def acquire(self, proxy_settings: ProxySettings, headless: bool) -> YandexMapsParser:
    key = self._proxy_key(proxy_settings)
    now = time.monotonic()
    with self._lock:
      entries = self._idle.get(key, [])
      while entries:
        parser, stored_at = entries.pop()
        if now - stored_at < self._idle_timeout and parser.driver is not None:
          return parser
        # expired or dead — close in background
        try:
          parser.close()
        except Exception:
          pass
      if not entries and key in self._idle:
        del self._idle[key]

    parser = YandexMapsParser(proxy_settings=proxy_settings, headless=headless)
    return parser

  def release(self, parser: YandexMapsParser, proxy_settings: ProxySettings) -> None:
    if parser.driver is None:
      return
    key = self._proxy_key(proxy_settings)
    try:
      parser.driver.get("about:blank")
    except Exception:
      try:
        parser.close()
      except Exception:
        pass
      return
    with self._lock:
      self._idle.setdefault(key, []).append((parser, time.monotonic()))

  def close_idle(self) -> None:
    now = time.monotonic()
    with self._lock:
      for key in list(self._idle.keys()):
        entries = self._idle[key]
        alive = []
        for parser, stored_at in entries:
          if now - stored_at >= self._idle_timeout:
            try:
              parser.close()
            except Exception:
              pass
          else:
            alive.append((parser, stored_at))
        if alive:
          self._idle[key] = alive
        else:
          del self._idle[key]


_pool = _BrowserPool()


class ProxyModel(BaseModel):
  enabled: bool = False
  protocol: Literal["http", "https", "socks5"] = "http"
  host: str = ""
  port: str = ""
  username: str = ""
  password: str = ""


class CollectLinksRequest(BaseModel):
  search_url: str = Field(min_length=1)
  max_results: int = Field(default=5000, ge=1, le=5000)
  headless: bool = True
  proxy: Optional[ProxyModel] = None


class CollectLinksResponse(BaseModel):
  links: list[str]


class ParseOrgsRequest(BaseModel):
  links: list[str] = Field(min_length=1)
  headless: bool = True
  proxy: Optional[ProxyModel] = None


class OrganizationModel(BaseModel):
  name: str = ""
  country: str = ""
  city: str = ""
  address: str = ""
  rating: str = ""
  reviews_count: str = ""
  website: str = ""
  email: str = ""
  phone: str = ""
  telegram: str = ""
  vk: str = ""
  instagram: str = ""
  whatsapp: str = ""
  card_url: str = ""
  working_hours: str = ""
  categories: str = ""


class ParseOrgsResponse(BaseModel):
  organizations: list[OrganizationModel]


def _to_proxy_settings(proxy: Optional[ProxyModel]) -> ProxySettings:
  if not proxy or not proxy.enabled:
    return ProxySettings(enabled=False)
  return ProxySettings(
    enabled=True,
    protocol=proxy.protocol,
    host=proxy.host,
    port=proxy.port,
    username=proxy.username,
    password=proxy.password,
  )


def _org_to_model(org: Organization) -> OrganizationModel:
  return OrganizationModel(
    name=org.name or "",
    country=org.country or "",
    city=org.city or "",
    address=org.address or "",
    rating=org.rating or "",
    reviews_count=org.reviews_count or "",
    website=org.website or "",
    email=org.email or "",
    phone=org.phone or "",
    telegram=org.telegram or "",
    vk=org.vk or "",
    instagram=org.instagram or "",
    whatsapp=org.whatsapp or "",
    card_url=org.card_url or "",
    working_hours=org.working_hours or "",
    categories=org.categories or "",
  )


@app.get("/health")
async def health():
  _pool.close_idle()
  return {"ok": True}


@app.post("/collect-links", response_model=CollectLinksResponse)
async def collect_links(req: CollectLinksRequest):
  proxy_settings = _to_proxy_settings(req.proxy)
  async with _REQUEST_SEMAPHORE:
    parser = _pool.acquire(proxy_settings, req.headless)
    failed = False
    try:
      links = await asyncio.wait_for(
        asyncio.to_thread(parser.collect_organization_links, req.search_url, req.max_results),
        timeout=COLLECT_TIMEOUT_SEC,
      )
      return CollectLinksResponse(links=links)
    except asyncio.TimeoutError:
      failed = True
      parser.stop()
      raise HTTPException(status_code=504, detail=f"collect-links timed out after {COLLECT_TIMEOUT_SEC}s")
    except Exception as e:
      failed = True
      raise HTTPException(status_code=500, detail=str(e))
    finally:
      if failed:
        parser.close()
      else:
        _pool.release(parser, proxy_settings)


@app.post("/collect-links/stream")
async def collect_links_stream(req: CollectLinksRequest):
  """NDJSON streaming: each line is {"links": [...], "total": N} or {"done": true, "total": N}."""
  proxy_settings = _to_proxy_settings(req.proxy)
  await _REQUEST_SEMAPHORE.acquire()

  link_queue: queue.Queue[dict | None] = queue.Queue()

  def on_links(batch: list[str], total: int) -> None:
    link_queue.put({"links": batch, "total": total})

  parser = _pool.acquire(proxy_settings, req.headless)

  async def generate():
    failed = False
    try:
      loop = asyncio.get_event_loop()
      task = loop.run_in_executor(
        None, parser.collect_organization_links, req.search_url, req.max_results, 480, on_links,
      )

      while True:
        try:
          msg = link_queue.get_nowait()
          if msg is not None:
            yield json.dumps(msg, ensure_ascii=False) + "\n"
        except queue.Empty:
          pass

        if task.done():
          while not link_queue.empty():
            msg = link_queue.get_nowait()
            if msg is not None:
              yield json.dumps(msg, ensure_ascii=False) + "\n"
          break

        await asyncio.sleep(0.3)

      all_links = task.result()
      yield json.dumps({"done": True, "total": len(all_links)}, ensure_ascii=False) + "\n"
    except Exception as e:
      failed = True
      yield json.dumps({"error": str(e)}, ensure_ascii=False) + "\n"
    finally:
      if failed:
        parser.close()
      else:
        _pool.release(parser, proxy_settings)
      _REQUEST_SEMAPHORE.release()

  return StreamingResponse(generate(), media_type="application/x-ndjson")


@app.post("/parse-orgs", response_model=ParseOrgsResponse)
async def parse_orgs(req: ParseOrgsRequest):
  proxy_settings = _to_proxy_settings(req.proxy)
  async with _REQUEST_SEMAPHORE:
    parser = _pool.acquire(proxy_settings, req.headless)
    failed = False
    try:
      orgs = await asyncio.wait_for(
        asyncio.to_thread(parser.parse_organizations_from_links, req.links),
        timeout=PARSE_TIMEOUT_SEC,
      )
      return ParseOrgsResponse(organizations=[_org_to_model(o) for o in orgs])
    except asyncio.TimeoutError:
      failed = True
      parser.stop()
      raise HTTPException(status_code=504, detail=f"parse-orgs timed out after {PARSE_TIMEOUT_SEC}s")
    except Exception as e:
      failed = True
      raise HTTPException(status_code=500, detail=str(e))
    finally:
      if failed:
        parser.close()
      else:
        _pool.release(parser, proxy_settings)

