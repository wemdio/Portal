import asyncio
import json
import os
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from yandex_parser import Organization, ProxySettings, YandexBlockedError, YandexMapsParser


app = FastAPI()
YANDEXMAPS_CONCURRENCY = int(os.environ.get("YANDEXMAPS_CONCURRENCY", "2"))
_REQUEST_SEMAPHORE = asyncio.Semaphore(YANDEXMAPS_CONCURRENCY)
# Таймауты — 15 мин на один URL (сбор ссылок) и 15 мин на пачку карточек.
# Через медленный мобильный прокси (1.6 Мбит/с) один URL с 200-500 карточками
# лениво догружает всё это 5-10 мин, плюс запас на ретраи скролла.
COLLECT_TIMEOUT_SEC = int(os.environ.get("YANDEXMAPS_COLLECT_TIMEOUT_SEC", "900"))
PARSE_TIMEOUT_SEC = int(os.environ.get("YANDEXMAPS_PARSE_TIMEOUT_SEC", "900"))
# max_seconds на один URL внутри парсера — 12 мин, чуть меньше HTTP-таймаута
# сверху, чтобы парсер успел вернуть частичный результат до 504.
COLLECT_MAX_SECONDS_PER_URL = int(os.environ.get("YANDEXMAPS_COLLECT_MAX_SECONDS_PER_URL", "720"))


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
  return {"ok": True}


@app.post("/collect-links", response_model=CollectLinksResponse)
async def collect_links(req: CollectLinksRequest):
  async with _REQUEST_SEMAPHORE:
    parser = YandexMapsParser(proxy_settings=_to_proxy_settings(req.proxy), headless=req.headless)
    try:
      await parser.start()
      links = await asyncio.wait_for(
        parser.collect_organization_links(req.search_url, req.max_results),
        timeout=COLLECT_TIMEOUT_SEC,
      )
      return CollectLinksResponse(links=links)
    except asyncio.TimeoutError:
      parser.stop()
      raise HTTPException(status_code=504, detail=f"collect-links timed out after {COLLECT_TIMEOUT_SEC}s")
    except YandexBlockedError as e:
      raise HTTPException(status_code=429, detail=f"yandex_blocked: {e}")
    except Exception as e:
      raise HTTPException(status_code=500, detail=str(e))
    finally:
      await parser.close()


@app.post("/collect-links/stream")
async def collect_links_stream(req: CollectLinksRequest):
  """NDJSON streaming: каждая строка — {"links": [...], "total": N} или {"done": true, "total": N}.

  Async-версия: on_links работает в том же event loop, batches
  передаются через asyncio.Queue напрямую (без потоков и polling).
  """
  await _REQUEST_SEMAPHORE.acquire()

  # Sentinel для «сбор завершён» — нужен, чтобы generate() не крутился впустую
  # в get(), если задача упала между двумя put'ами.
  DONE = object()
  link_queue: asyncio.Queue = asyncio.Queue()

  def on_links(batch: list[str], total: int) -> None:
    # on_links вызывается из await'ов внутри collect_organization_links —
    # мы в том же event loop, put_nowait безопасен.
    try:
      link_queue.put_nowait({"links": batch, "total": total})
    except Exception:
      pass

  parser = YandexMapsParser(proxy_settings=_to_proxy_settings(req.proxy), headless=req.headless)

  async def run_collect():
    try:
      await parser.start()
      links = await asyncio.wait_for(
        parser.collect_organization_links(
          req.search_url, req.max_results, max_seconds=COLLECT_MAX_SECONDS_PER_URL, on_links=on_links
        ),
        timeout=COLLECT_TIMEOUT_SEC,
      )
      await link_queue.put({"__done": True, "total": len(links)})
    except YandexBlockedError as e:
      await link_queue.put({"__error": f"yandex_blocked: {e}", "__blocked": True})
    except asyncio.TimeoutError:
      await link_queue.put({"__error": f"collect-links timed out after {COLLECT_TIMEOUT_SEC}s"})
    except Exception as e:
      await link_queue.put({"__error": str(e)})
    finally:
      await link_queue.put(DONE)

  async def generate():
    task = asyncio.create_task(run_collect())
    try:
      while True:
        msg = await link_queue.get()
        if msg is DONE:
          break
        if "__error" in msg:
          error_payload = {"error": msg["__error"]}
          if msg.get("__blocked"):
            error_payload["blocked"] = True
          yield json.dumps(error_payload, ensure_ascii=False) + "\n"
        elif "__done" in msg:
          yield json.dumps({"done": True, "total": msg["total"]}, ensure_ascii=False) + "\n"
        else:
          yield json.dumps(msg, ensure_ascii=False) + "\n"
    finally:
      # Дожидаемся завершения task, чтобы close() случился после collect.
      try:
        await task
      except Exception:
        pass
      await parser.close()
      _REQUEST_SEMAPHORE.release()

  return StreamingResponse(generate(), media_type="application/x-ndjson")


@app.post("/parse-orgs", response_model=ParseOrgsResponse)
async def parse_orgs(req: ParseOrgsRequest):
  async with _REQUEST_SEMAPHORE:
    parser = YandexMapsParser(proxy_settings=_to_proxy_settings(req.proxy), headless=req.headless)
    try:
      await parser.start()
      orgs = await asyncio.wait_for(
        parser.parse_organizations_from_links(req.links),
        timeout=PARSE_TIMEOUT_SEC,
      )
      return ParseOrgsResponse(organizations=[_org_to_model(o) for o in orgs])
    except asyncio.TimeoutError:
      parser.stop()
      raise HTTPException(status_code=504, detail=f"parse-orgs timed out after {PARSE_TIMEOUT_SEC}s")
    except YandexBlockedError as e:
      raise HTTPException(status_code=429, detail=f"yandex_blocked: {e}")
    except Exception as e:
      raise HTTPException(status_code=500, detail=str(e))
    finally:
      await parser.close()
