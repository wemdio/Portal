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
# Расщеплённые семафоры (16.07.2026): раньше был один _REQUEST_SEMAPHORE=2 на
# весь сервис, гейтивший и /collect-links/stream, и /parse-orgs. Это душило
# параллелизм на этапе парсинга карточек: даже с 5+ прокси одновременно
# работали 2 контекста, а Node-воркер параллелил чанки в упор в потолок.
# Теперь COLLECT_CONCURRENCY и PARSE_CONCURRENCY независимы: сбор ссылок
# тяжелее (одна долгая страница на 5-15 мин), парсинг легче, но их много —
# держим PARSE выше. Верхняя граница определяется RAM: один chromium ~250 МБ,
# 8 контекстов ≈ 2 ГБ — терпимо на app-сервере.
YANDEXMAPS_CONCURRENCY = int(os.environ.get("YANDEXMAPS_CONCURRENCY", "0"))  # legacy: если >0, задаёт оба (обратная совместимость)
_LEGACY = YANDEXMAPS_CONCURRENCY if YANDEXMAPS_CONCURRENCY > 0 else None
COLLECT_CONCURRENCY = _LEGACY or int(os.environ.get("YANDEXMAPS_COLLECT_CONCURRENCY", "5"))
PARSE_CONCURRENCY = _LEGACY or int(os.environ.get("YANDEXMAPS_PARSE_CONCURRENCY", "5"))
_COLLECT_SEMAPHORE = asyncio.Semaphore(COLLECT_CONCURRENCY)
_PARSE_SEMAPHORE = asyncio.Semaphore(PARSE_CONCURRENCY)
# Таймауты — 15 мин на один URL (сбор ссылок) и 15 мин на пачку карточек.
# Через медленный мобильный прокси (1.6 Мбит/с) один URL с 200-500 карточками
# лениво догружает всё это 5-10 мин, плюс запас на ретраи скролла.
COLLECT_TIMEOUT_SEC = int(os.environ.get("YANDEXMAPS_COLLECT_TIMEOUT_SEC", "900"))
PARSE_TIMEOUT_SEC = int(os.environ.get("YANDEXMAPS_PARSE_TIMEOUT_SEC", "900"))
# max_seconds на один URL внутри парсера — 12 мин, чуть меньше HTTP-таймаута
# сверху, чтобы парсер успел вернуть частичный результат до 504.
COLLECT_MAX_SECONDS_PER_URL = int(os.environ.get("YANDEXMAPS_COLLECT_MAX_SECONDS_PER_URL", "720"))
# Heartbeat интервал для NDJSON-стрима — undici body-timeout=300s рвёт сокет
# при затыках. Ловили инциденте 15.07.2026: yandex.com отдавал 5 карточек,
# скролл 40 итераций впустую = 3 мин тишины → все 9 URL умерли с
# TypeError: terminated. Heartbeat каждые 25с гарантирует, что undici видит
# трафик и держит соединение.
COLLECT_STREAM_HEARTBEAT_SEC = float(os.environ.get("YANDEXMAPS_COLLECT_STREAM_HEARTBEAT_SEC", "25"))


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
  async with _COLLECT_SEMAPHORE:
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

  Cleanup-контракт (инцидент 14.07.2026): release семафора и закрытие
  браузера живут в finally run_collect — отдельной task, которую обрыв
  клиента не отменяет. Раньше cleanup был в finally generate(): когда
  клиент отваливался (таймаут воркера 10 мин < наших 12-15 мин), Starlette
  отменял generate(), первый же await в его finally ловил CancelledError,
  parser.close() и release() не выполнялись. Два оборванных стрима — и оба
  слота семафора утекли: все новые запросы вечно висели в acquire(),
  задачи «шли» часами с 0 ссылок, а зомби-chromium жили до рестарта.
  """
  await _COLLECT_SEMAPHORE.acquire()

  # Sentinel для «сбор завершён» — нужен, чтобы generate() не крутился впустую
  # в get(), если задача упала между двумя put'ами.
  DONE = object()
  # Sentinel для heartbeat — generate() рендерит его в отдельную NDJSON-строку
  # {"tick": true}, undici видит трафик и не рвёт соединение.
  TICK = object()
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
      await link_queue.put({"__done": True, "total": len(links)})
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
      _COLLECT_SEMAPHORE.release()
      link_queue.put_nowait(DONE)
      asyncio.create_task(close_parser_detached())

  async def heartbeat_ticker():
    """Раз в COLLECT_STREAM_HEARTBEAT_SEC пушит TICK-сентинел.

    Инцидент 15.07.2026: yandex.com отдавал 5 карточек, скролл делал 40
    пустых итераций (~3 мин) — undici body-timeout (300s) закрывал сокет,
    все 9 URL валились с TypeError: terminated. Собственный keepalive в
    парсере условен ("шлём только если ссылок прибавилось") — во время
    затыка он молчит. Тикер шлёт сигнал жизни безусловно, generate()
    рендерит его в {"tick": true} NDJSON — undici видит трафик и держит
    соединение.
    """
    try:
      while True:
        await asyncio.sleep(COLLECT_STREAM_HEARTBEAT_SEC)
        link_queue.put_nowait(TICK)
    except asyncio.CancelledError:
      pass

  async def generate():
    task = asyncio.create_task(run_collect())
    tick_task = asyncio.create_task(heartbeat_ticker())
    try:
      while True:
        msg = await link_queue.get()
        if msg is DONE:
          break
        if msg is TICK:
          yield json.dumps({"tick": True}, ensure_ascii=False) + "\n"
          continue
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
      # Мы можем быть в отменённом anyio-scope (клиент отвалился) — здесь
      # нельзя await'ить. cancel() синхронный; cleanup сделает сам
      # run_collect в своём finally.
      if not tick_task.done():
        tick_task.cancel()
      if not task.done():
        task.cancel()

  return StreamingResponse(generate(), media_type="application/x-ndjson")


@app.post("/parse-orgs", response_model=ParseOrgsResponse)
async def parse_orgs(req: ParseOrgsRequest):
  async with _PARSE_SEMAPHORE:
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
