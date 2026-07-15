import asyncio
import json
import os
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from playwright.async_api import async_playwright
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
# Пульс стрима: undici в воркере рвёт соединение (bodyTimeout 300с), если по
# стриму 5 минут не приходит НИ БАЙТА. Инцидент 15.07.2026 (#790ce9bf): на
# международной выдаче yandex.com новые карточки перестают приходить, парсер
# честно скроллит дальше, но в стрим ничего не пишется — все 9 запросов ночного
# запуска умерли с `TypeError: terminated` ровно через ~5 минут тишины.
# Пульс шлётся из generate() независимо от состояния парсера.
STREAM_HEARTBEAT_SEC = int(os.environ.get("YANDEXMAPS_STREAM_HEARTBEAT_SEC", "20"))


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
  intl_redirect: bool = False


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


class ProxyCheckRequest(BaseModel):
  proxy: Optional[ProxyModel] = None
  timeout_sec: int = Field(default=15, ge=3, le=60)


@app.post("/proxy-check")
async def proxy_check(req: ProxyCheckRequest):
  """Быстрый замер скорости прокси БЕЗ запуска браузера.

  Качаем ~287 КБ статики через APIRequestContext и меряем скорость.
  Воркер зовёт это перед задачей и выкидывает из ротации прокси, которые
  не тянут. Инцидент 14.07.2026: shared LTE-каналы проседали до 2.7 КБ/с,
  страница Карт не загружалась в принципе, а парсер продолжал гонять все
  URL через мёртвые прокси и «завершал» задачи с 0 ссылок.

  Семафором не гейтим: запрос дешёвый (без chromium), а гейт заставил бы
  чек ждать за длинными collect'ами.
  """
  test_url = "https://code.jquery.com/jquery-3.7.1.js"  # ~287 КБ, стабильный CDN
  proxy = _to_proxy_settings(req.proxy).to_playwright_proxy()
  loop = asyncio.get_event_loop()
  started = loop.time()
  try:
    async with async_playwright() as pw:
      ctx = await pw.request.new_context(proxy=proxy)
      try:
        resp = await ctx.get(test_url, timeout=req.timeout_sec * 1000)
        body = await resp.body()
        elapsed = max(loop.time() - started, 0.001)
        return {
          "ok": bool(resp.ok) and len(body) > 0,
          "bytes": len(body),
          "seconds": round(elapsed, 2),
          "speed_bps": int(len(body) / elapsed),
        }
      finally:
        await ctx.dispose()
  except Exception as e:
    return {
      "ok": False,
      "error": str(e)[:200],
      "seconds": round(loop.time() - started, 2),
      "speed_bps": 0,
    }


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
      return CollectLinksResponse(links=links, intl_redirect=parser.intl_redirect_detected)
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

  Cleanup-контракт (инцидент 14.07.2026): release семафора и закрытие
  браузера живут в finally run_collect — отдельной task, которую обрыв
  клиента не отменяет. Раньше cleanup был в finally generate(): когда
  клиент отваливался (таймаут воркера 10 мин < наших 12-15 мин), Starlette
  отменял generate(), первый же await в его finally ловил CancelledError,
  parser.close() и release() не выполнялись. Два оборванных стрима — и оба
  слота семафора утекли: все новые запросы вечно висели в acquire(),
  задачи «шли» часами с 0 ссылок, а зомби-chromium жили до рестарта.
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

  async def close_parser_detached():
    try:
      await parser.close()
    except Exception:
      pass

  async def run_collect():
    try:
      await parser.start()
      links = await asyncio.wait_for(
        parser.collect_organization_links(
          req.search_url, req.max_results, max_seconds=COLLECT_MAX_SECONDS_PER_URL, on_links=on_links
        ),
        timeout=COLLECT_TIMEOUT_SEC,
      )
      await link_queue.put({"__done": True, "total": len(links), "__intl_redirect": parser.intl_redirect_detected})
    except YandexBlockedError as e:
      await link_queue.put({"__error": f"yandex_blocked: {e}", "__blocked": True})
    except asyncio.TimeoutError:
      await link_queue.put({"__error": f"collect-links timed out after {COLLECT_TIMEOUT_SEC}s"})
    except Exception as e:
      await link_queue.put({"__error": str(e)})
    finally:
      # Только синхронные вызовы: если run_collect отменили (task.cancel()
      # из generate при обрыве клиента), любой await здесь сразу словит
      # CancelledError и оставшиеся строки не выполнятся. release() и
      # put_nowait синхронны — выполняются гарантированно; браузер
      # закрываем отдельной task, её отмена нас уже не касается.
      _REQUEST_SEMAPHORE.release()
      link_queue.put_nowait(DONE)
      asyncio.create_task(close_parser_detached())

  async def generate():
    task = asyncio.create_task(run_collect())
    last_total = 0
    try:
      while True:
        try:
          msg = await asyncio.wait_for(link_queue.get(), timeout=STREAM_HEARTBEAT_SEC)
        except asyncio.TimeoutError:
          # Тишина от парсера (скроллит, но новых карточек нет) — шлём пульс,
          # чтобы undici-клиент воркера не убил стрим по body-timeout.
          yield json.dumps({"heartbeat": True, "total": last_total}, ensure_ascii=False) + "\n"
          continue
        if msg is DONE:
          break
        if "__error" in msg:
          error_payload = {"error": msg["__error"]}
          if msg.get("__blocked"):
            error_payload["blocked"] = True
          yield json.dumps(error_payload, ensure_ascii=False) + "\n"
        elif "__done" in msg:
          done_payload = {"done": True, "total": msg["total"]}
          if msg.get("__intl_redirect"):
            done_payload["intl_redirect"] = True
          yield json.dumps(done_payload, ensure_ascii=False) + "\n"
        else:
          last_total = int(msg.get("total") or last_total)
          yield json.dumps(msg, ensure_ascii=False) + "\n"
    finally:
      # Мы можем быть в отменённом anyio-scope (клиент отвалился) — здесь
      # нельзя await'ить. cancel() синхронный; cleanup сделает сам
      # run_collect в своём finally.
      if not task.done():
        task.cancel()

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
