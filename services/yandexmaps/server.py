import asyncio
import json
import os
import queue
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from yandex_parser import Organization, ProxySettings, YandexBlockedError, YandexMapsParser


app = FastAPI()
YANDEXMAPS_CONCURRENCY = int(os.environ.get("YANDEXMAPS_CONCURRENCY", "2"))
_REQUEST_SEMAPHORE = asyncio.Semaphore(YANDEXMAPS_CONCURRENCY)
COLLECT_TIMEOUT_SEC = int(os.environ.get("YANDEXMAPS_COLLECT_TIMEOUT_SEC", "540"))
PARSE_TIMEOUT_SEC = int(os.environ.get("YANDEXMAPS_PARSE_TIMEOUT_SEC", "540"))


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
      links = await asyncio.wait_for(
        asyncio.to_thread(parser.collect_organization_links, req.search_url, req.max_results),
        timeout=COLLECT_TIMEOUT_SEC,
      )
      return CollectLinksResponse(links=links)
    except asyncio.TimeoutError:
      parser.stop()
      raise HTTPException(status_code=504, detail=f"collect-links timed out after {COLLECT_TIMEOUT_SEC}s")
    except Exception as e:
      raise HTTPException(status_code=500, detail=str(e))
    finally:
      parser.close()


@app.post("/collect-links/stream")
async def collect_links_stream(req: CollectLinksRequest):
  """NDJSON streaming: each line is {"links": [...], "total": N} or {"done": true, "total": N}."""
  await _REQUEST_SEMAPHORE.acquire()

  link_queue: queue.Queue[dict | None] = queue.Queue()

  def on_links(batch: list[str], total: int) -> None:
    link_queue.put({"links": batch, "total": total})

  parser = YandexMapsParser(proxy_settings=_to_proxy_settings(req.proxy), headless=req.headless)

  async def generate():
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
      yield json.dumps({"error": str(e)}, ensure_ascii=False) + "\n"
    finally:
      parser.close()
      _REQUEST_SEMAPHORE.release()

  return StreamingResponse(generate(), media_type="application/x-ndjson")


@app.post("/parse-orgs", response_model=ParseOrgsResponse)
async def parse_orgs(req: ParseOrgsRequest):
  async with _REQUEST_SEMAPHORE:
    parser = YandexMapsParser(proxy_settings=_to_proxy_settings(req.proxy), headless=req.headless)
    try:
      orgs = await asyncio.wait_for(
        asyncio.to_thread(parser.parse_organizations_from_links, req.links),
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
      parser.close()

