import asyncio
import os
import random
import re
from dataclasses import dataclass
from typing import Any, Callable, List, Optional

from bs4 import BeautifulSoup
from playwright.async_api import (
  Browser,
  BrowserContext,
  Page,
  Playwright,
  TimeoutError as PWTimeoutError,
  async_playwright,
)
from playwright_stealth import stealth_async


class YandexBlockedError(Exception):
  """Yandex вернул капчу / антибот-страницу вместо результатов."""


PARSE_MIN_DELAY_SEC = float(os.environ.get("YANDEXMAPS_PARSE_MIN_DELAY_SEC", "1.5"))
PARSE_MAX_DELAY_SEC = float(os.environ.get("YANDEXMAPS_PARSE_MAX_DELAY_SEC", "3.0"))
PARSE_MAX_CONSECUTIVE_EMPTY = int(os.environ.get("YANDEXMAPS_PARSE_MAX_CONSECUTIVE_EMPTY", "5"))


# Свежий пул User-Agent'ов: Chrome 130-131 на разных ОС + мобильный Android.
# Обновлять раз в 3-6 мес — старые версии сами по себе триггерят подозрение.
USER_AGENT_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
]

WINDOW_SIZES_DESKTOP = [(1366, 768), (1440, 900), (1536, 864), (1920, 1080)]
WINDOW_SIZES_MOBILE = [(412, 915), (390, 844), (375, 812)]


@dataclass
class Organization:
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


@dataclass
class ProxySettings:
  enabled: bool = False
  protocol: str = "http"
  host: str = ""
  port: str = ""
  username: str = ""
  password: str = ""

  def to_playwright_proxy(self) -> Optional[dict]:
    """Возвращает proxy-dict в формате Playwright launch(), либо None.

    В отличие от Selenium+mitmproxy — Playwright умеет auth-прокси нативно:
    просто передаём username/password в launch(), никаких MITM-костылей."""
    if not self.enabled or not self.host:
      return None
    server = f"{self.protocol}://{self.host}:{self.port}"
    proxy: dict = {"server": server}
    if self.username and self.password:
      proxy["username"] = self.username
      proxy["password"] = self.password
    return proxy


# Ресурсные фрагменты URL, которые блокируем на уровне сетевого роутинга.
# Экономит ~70-80% трафика прокси и в разы ускоряет загрузку. HTML/JS/CSS
# оставляем — Яндекс.Карты рендерят список динамически, без них DOM пустой.
_HEAVY_URL_MARKERS = (
  "core-renderer-tiles",
  "/tiles",
  "/services/tiles",
  "tile.maps.yandex",
  "sat.maps.yandex",
  "vec.maps.yandex",
  "avatars.mds.yandex",
  "avatars.mdst.yandex",
  "mc.yandex.ru/metrika",
  "mc.yandex.ru/watch",
  "mc.webvisor",
  "an.yandex.ru",
  "yandexadexchange.net",
)
_HEAVY_RESOURCE_TYPES = {"image", "media", "font"}


class YandexMapsParser:
  """Async-парсер Яндекс.Карт на Playwright.

  Использование::

      parser = YandexMapsParser(proxy_settings=..., headless=True)
      await parser.start()
      try:
          links = await parser.collect_organization_links(url)
          orgs = await parser.parse_organizations_from_links(links)
      finally:
          await parser.close()

  Одна инстанция парсера = один browser+context, переиспользуются между
  запросами (карточки открываются в новых page, старые закрываются).
  """

  def __init__(
    self,
    proxy_settings: Optional[ProxySettings] = None,
    headless: bool = True,
    progress_callback: Optional[Callable[[int, int, str], None]] = None,
    log_callback: Optional[Callable[[str], None]] = None,
  ):
    self.proxy_settings = proxy_settings or ProxySettings()
    self.headless = headless
    self.progress_callback = progress_callback
    self.log_callback = log_callback
    self._pw: Optional[Playwright] = None
    self._browser: Optional[Browser] = None
    self._context: Optional[BrowserContext] = None
    self.is_running = False

  # ── логирование / progress ─────────────────────────────────────────

  def log(self, message: str):
    if self.log_callback:
      try:
        self.log_callback(message)
      except Exception:
        pass
    try:
      print(self._make_safe_string(message))
    except Exception:
      pass

  def _make_safe_string(self, text: str) -> str:
    emoji_map = {
      "\U0001f4cc": "[PIN]",
      "❌": "[X]",
      "✅": "[OK]",
      "\U0001f50d": "[SEARCH]",
      "⏳": "[WAIT]",
      "\U0001f4cb": "[LIST]",
      "\U0001f504": "[SYNC]",
      "⚠️": "[!]",
      "⚠": "[!]",
      "⏹️": "[STOP]",
      "⏹": "[STOP]",
      "\U0001f680": "[START]",
      "ℹ️": "[i]",
      "ℹ": "[i]",
    }
    result = text
    for emoji, replacement in emoji_map.items():
      result = result.replace(emoji, replacement)
    return result

  def update_progress(self, current: int, total: int, message: str = ""):
    if self.progress_callback:
      self.progress_callback(current, total, message)

  # ── жизненный цикл браузера ───────────────────────────────────────

  async def start(self):
    """Создаёт Playwright, browser и context. Идемпотентно."""
    if self._context:
      return

    self._pw = await async_playwright().start()

    launch_kwargs: dict = {
      "headless": self.headless,
      "args": [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--lang=ru-RU",
        # Blink не грузит картинки на уровне рендера — двойная защита
        # поверх сетевого routing'а ниже.
        "--blink-settings=imagesEnabled=false",
      ],
    }
    proxy = self.proxy_settings.to_playwright_proxy()
    if proxy:
      launch_kwargs["proxy"] = proxy

    self._browser = await self._pw.chromium.launch(**launch_kwargs)

    # Рандомизация UA + viewport — пары согласованы (мобильный UA + мобильный
    # экран), иначе Client-Hints выдают противоречие → Яндекс палит бота.
    ua = random.choice(USER_AGENT_POOL)
    is_mobile = "Mobile" in ua
    width, height = random.choice(WINDOW_SIZES_MOBILE if is_mobile else WINDOW_SIZES_DESKTOP)

    self._context = await self._browser.new_context(
      user_agent=ua,
      viewport={"width": width, "height": height},
      locale="ru-RU",
      timezone_id="Europe/Moscow",
      is_mobile=is_mobile,
    )
    # Блокируем тяжёлые ресурсы (тайлы, картинки, метрика) на уровне routing.
    await self._context.route("**/*", self._block_heavy_route)

  async def _block_heavy_route(self, route: Any):
    try:
      req = route.request
      rt = req.resource_type
      url = req.url.lower()
      if rt in _HEAVY_RESOURCE_TYPES:
        await route.abort()
        return
      if any(m in url for m in _HEAVY_URL_MARKERS):
        await route.abort()
        return
      await route.continue_()
    except Exception:
      try:
        await route.continue_()
      except Exception:
        pass

  async def close(self):
    if self._context:
      try:
        await self._context.close()
      except Exception:
        pass
      self._context = None
    if self._browser:
      try:
        await self._browser.close()
      except Exception:
        pass
      self._browser = None
    if self._pw:
      try:
        await self._pw.stop()
      except Exception:
        pass
      self._pw = None

  def stop(self):
    self.is_running = False
    self.log("[STOP] Остановка парсера...")

  # ── детект блокировки ────────────────────────────────────────────

  async def _page_looks_blocked(self, page: Page) -> bool:
    """Показывает ли Яндекс капчу/антибот вместо результатов.

    Смотрим URL (редирект на showcaptcha) и HTML на специфичные маркеры
    SmartCaptcha — избегаем ложных срабатываний на просто пустой выдаче.
    """
    try:
      current_url = (page.url or "").lower()
    except Exception:
      current_url = ""
    if "showcaptcha" in current_url or "checkcaptcha" in current_url:
      return True

    try:
      html = (await page.content()).lower()
    except Exception:
      return False

    markers = [
      "smartcaptcha",
      "showcaptcha",
      "checkbox-captcha",
      "js-button-captcha",
      "подтвердите, что запросы отправляли вы",
      "подтвердите, что вы не робот",
      "вы не робот",
      "confirm that you and not a robot",
      "are you not a robot",
    ]
    return any(m in html for m in markers)

  # ── сбор ссылок из поиска ────────────────────────────────────────

  def generate_search_url(self, query: str, city: str = "") -> str:
    from urllib.parse import quote

    search_query = f"{city} {query}".strip() if city else query
    encoded_query = quote(search_query)
    return f"https://yandex.ru/maps/?text={encoded_query}"

  async def collect_organization_links(
    self,
    search_url: str,
    max_results: int = 5000,
    max_seconds: int = 480,
    on_links: Optional[Callable[[List[str], int], None]] = None,
  ) -> List[str]:
    if not self._context:
      await self.start()

    self.is_running = True
    links: List[str] = []
    links_set: set[str] = set()
    loop = asyncio.get_event_loop()
    deadline = loop.time() + max_seconds

    page = await self._context.new_page()
    # Stealth-патчи (navigator.webdriver, WebGL, plugins и т.п.) — до первой
    # навигации, иначе часть fingerprint'а Яндекс успеет снять на старте.
    try:
      await stealth_async(page)
    except Exception as e:
      self.log(f"[!] stealth_async не применился: {e}")
    try:
      try:
        # 90s — первичная загрузка через медленный мобильный прокси
        # (1.6 Мбит/с). Яндекс.Карты — тяжёлая SPA: сотни kB JS + шрифты
        # + инициализация Redux/React + первый JSON-запрос за списком.
        # На быстром интернете 5-10 сек, тут 20-40, а иногда до минуты.
        await page.goto(search_url, wait_until="domcontentloaded", timeout=90000)
      except PWTimeoutError:
        # Не бросаем — часть карточек может быть уже в DOM.
        self.log(f"[!] page.goto timeout 90s для {search_url}, пробуем работать с тем что есть")

      if await self._page_looks_blocked(page):
        raise YandexBlockedError("Яндекс показал капчу при загрузке страницы поиска")

      try:
        # 60s ждём пока Яндекс дорендерит первую пачку карточек. React
        # хёдрирует DOM после первого JSON-ответа с сервера — на медленных
        # прокси это до минуты после DOMContentLoaded.
        await page.wait_for_selector(
          "[class*='search-snippet'], [class*='search-list'], [class*='search-business']",
          timeout=60000,
        )
      except PWTimeoutError:
        await asyncio.sleep(3)
      await asyncio.sleep(2)

      sidebar = None
      # 5 попыток по 2 сек = 10 сек на поиск сайдбара — с запасом на случай,
      # если React ещё пересобирает layout.
      for _ in range(5):
        sidebar = await self._find_sidebar(page)
        if sidebar:
          break
        await asyncio.sleep(2)

      if not sidebar:
        if await self._page_looks_blocked(page):
          raise YandexBlockedError("Яндекс показал капчу (список организаций не загрузился)")
        html = await page.content()
        soup = BeautifulSoup(html, "lxml")
        links = self._extract_links_from_soup(soup)
        result = links[:max_results]
        if on_links and result:
          on_links(result, len(result))
        return result

      scroll_attempts = 0
      max_scroll_attempts = max_results * 3 + 200
      last_count = 0
      no_new_results_count = 0
      last_scroll_height = 0
      consecutive_same_height = 0
      last_reported = 0

      stale_count = 0
      while (
        len(links) < max_results
        and scroll_attempts < max_scroll_attempts
        and self.is_running
        and loop.time() < deadline
      ):
        # Яндекс.Карты — React-приложение. При подгрузке новых карточек
        # он пересобирает DOM внутри сайдбара, старый ElementHandle
        # становится stale (evaluate/scroll молча падает в except pass,
        # никаких новых карточек не появляется). Переполучаем handle
        # заново на каждой итерации — операция дешёвая (~5 мс).
        fresh_sidebar = await self._find_sidebar(page)
        if fresh_sidebar:
          sidebar = fresh_sidebar
          stale_count = 0
        else:
          stale_count += 1
          if stale_count >= 5:
            self.log(f"[!] Сайдбар не находится 5 итераций подряд, выходим")
            break

        for _ in range(3):
          await self._scroll_sidebar(sidebar)
          # Скроллы внутри итерации не спешим — Яндекс лениво подгружает
          # новые карточки, гнать быстрее = страница отстаёт.
          await asyncio.sleep(0.6)

        # Крупная пауза после серии скроллов — сеть занята подгрузкой
        # JSON'а с новыми карточками, DOM ещё пуст. На медленном
        # мобильном прокси до секунды-двух.
        await asyncio.sleep(1.5)

        html = await page.content()
        soup = BeautifulSoup(html, "lxml")
        new_links = self._extract_links_from_soup(soup)

        batch: List[str] = []
        for link in new_links:
          if link not in links_set:
            links_set.add(link)
            links.append(link)
            batch.append(link)

        if on_links and batch:
          on_links(batch, len(links))
          last_reported = len(links)
        elif on_links and scroll_attempts % 10 == 0 and len(links) != last_reported:
          on_links([], len(links))
          last_reported = len(links)

        try:
          scroll_state = await sidebar.evaluate(
            "(el) => ({sh: el.scrollHeight, st: el.scrollTop, ch: el.clientHeight})"
          )
          current_scroll_height = int(scroll_state.get("sh", 0) or 0)
          current_scroll_top = int(scroll_state.get("st", 0) or 0)
          client_height = int(scroll_state.get("ch", 0) or 0)
        except Exception as e:
          # Handle всё-таки stale (детач'нулся между fresh_sidebar
          # и scroll'ом). Логируем — раньше молча съедалось, и в
          # результате парсер собирал 5 карточек вместо 25.
          if scroll_attempts < 3 or scroll_attempts % 20 == 0:
            self.log(f"[!] sidebar.evaluate failed (attempt {scroll_attempts}): {e}")
          current_scroll_height = 0
          current_scroll_top = 0
          client_height = 0

        at_bottom = current_scroll_top + client_height >= current_scroll_height - 100

        if len(links) == last_count:
          no_new_results_count += 1
          if current_scroll_height == last_scroll_height and current_scroll_height > 0:
            consecutive_same_height += 1
          else:
            consecutive_same_height = 0

          if no_new_results_count % 4 == 0:
            await self._alternative_scroll(sidebar, page)
            await asyncio.sleep(2.5)

          # Условие выхода — 40 итераций без новых карточек. На медленных
          # прокси одна итерация ~4-5 сек = ~3 мин ожидания подгрузки
          # перед тем как сдаться. Плюс at_bottom + одинаковая высота
          # сайдбара 8 раз подряд — гарантия, что реально ничего не грузится.
          if at_bottom and consecutive_same_height >= 8 and no_new_results_count >= 40:
            break

          if no_new_results_count >= 15:
            await self._force_scroll_bottom(sidebar)
            # Крупная пауза после force-scroll — даём Яндексу до 3 сек
            # отреагировать на "мы у самого дна, догрузи-ка ещё".
            await asyncio.sleep(3.0)
        else:
          no_new_results_count = 0
          consecutive_same_height = 0
          last_count = len(links)

        last_scroll_height = current_scroll_height

        if scroll_attempts % 3 == 0:
          self.update_progress(len(links), max_results, f"Найдено: {len(links)}")

        if len(links) >= max_results:
          break

        # Пауза в конце итерации. Когда Яндекс "думает" (no_new_results_count
        # растёт) — ждём дольше. На медленном прокси лениво загружаемая
        # порция карточек приходит с задержкой 2-3 сек.
        await asyncio.sleep(2.5 if no_new_results_count > 6 else 1.2)
        scroll_attempts += 1

      if loop.time() >= deadline:
        self.log(f"[!] Таймаут сбора ссылок ({max_seconds}с), собрано {len(links)}")

      return links[:max_results]
    except YandexBlockedError:
      raise
    except Exception as e:
      self.log(f"[X] Ошибка при сборе ссылок: {e}")
      return links[:max_results]
    finally:
      self.is_running = False
      try:
        await page.close()
      except Exception:
        pass

  async def _find_sidebar(self, page: Page):
    """Возвращает ElementHandle скроллящегося сайдбара, либо None."""
    js = """
    () => {
      var scrollContainer = document.querySelector('.scroll__container');
      if (scrollContainer && scrollContainer.scrollHeight > scrollContainer.clientHeight) return scrollContainer;
      var sidebar = document.querySelector('[class*="sidebar-view__panel"]') || document.querySelector('[class*="sidebar"]');
      if (sidebar) {
        var scrollables = sidebar.querySelectorAll('*');
        var bestMatch = null;
        var maxHeight = 0;
        for (var i = 0; i < scrollables.length; i++) {
          var el = scrollables[i];
          var style = window.getComputedStyle(el);
          if ((style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto') && el.scrollHeight > el.clientHeight && el.clientHeight > 200) {
            if (el.scrollHeight > maxHeight) { maxHeight = el.scrollHeight; bestMatch = el; }
          }
        }
        if (bestMatch) return bestMatch;
      }
      var allScrolls = document.querySelectorAll('[class*="scroll"]');
      for (var j = 0; j < allScrolls.length; j++) {
        var s = allScrolls[j];
        if (s.scrollHeight > s.clientHeight && s.clientHeight > 200) {
          var rect = s.getBoundingClientRect();
          if (rect.height > 300) return s;
        }
      }
      return null;
    }
    """
    try:
      handle = await page.evaluate_handle(js)
    except Exception:
      return None
    try:
      element = handle.as_element()
      if element is None:
        await handle.dispose()
        return None
      return element
    except Exception:
      return None

  async def _scroll_sidebar(self, element):
    try:
      await element.evaluate(
        "(el) => { el.scrollTop += 2000; el.dispatchEvent(new Event('scroll', { bubbles: true })); }"
      )
    except Exception:
      pass

  async def _alternative_scroll(self, element, page: Page):
    try:
      await element.evaluate(
        "(el) => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll', { bubbles: true })); }"
      )
      await page.evaluate(
        "() => { document.querySelectorAll('[class*=\"scroll\"], [class*=\"sidebar\"]').forEach(function(c) { if (c.scrollHeight > c.clientHeight) { c.scrollTop = c.scrollHeight; c.dispatchEvent(new Event('scroll', { bubbles: true })); } }); }"
      )
    except Exception:
      pass

  async def _force_scroll_bottom(self, element):
    try:
      await element.evaluate(
        "(el) => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll', { bubbles: true })); el.dispatchEvent(new WheelEvent('wheel', { deltaY: 5000 })); }"
      )
      await asyncio.sleep(0.5)
    except Exception:
      pass

  # ── парсинг карточек ─────────────────────────────────────────────

  async def parse_organizations_from_links(
    self, links: List[str], max_seconds: int = 480
  ) -> List[Organization]:
    if not self._context:
      await self.start()

    self.is_running = True
    organizations: List[Organization] = []
    loop = asyncio.get_event_loop()
    deadline = loop.time() + max_seconds
    consecutive_empty = 0

    try:
      for i, url in enumerate(links):
        if not self.is_running or loop.time() > deadline:
          break
        self.update_progress(i + 1, len(links), f"Парсинг: {i + 1}/{len(links)}")
        org = await self.parse_organization(url)
        if org.name:
          organizations.append(org)
          consecutive_empty = 0
        else:
          consecutive_empty += 1
          if consecutive_empty >= PARSE_MAX_CONSECUTIVE_EMPTY:
            self.log(
              f"[!] {consecutive_empty} карточек подряд без данных — "
              f"вероятно Яндекс включил антибот/капчу. Останавливаем чанк."
            )
            raise YandexBlockedError(
              f"Не удалось извлечь данные из {consecutive_empty} карточек подряд. "
              "Возможно, Яндекс временно блокирует запросы."
            )
        await asyncio.sleep(random.uniform(PARSE_MIN_DELAY_SEC, PARSE_MAX_DELAY_SEC))
      return organizations
    except YandexBlockedError:
      raise
    except Exception as e:
      self.log(f"[X] Критическая ошибка: {e}")
      return organizations
    finally:
      self.is_running = False

  async def parse_organization(self, url: str) -> Organization:
    org = Organization(card_url=url)
    page = await self._context.new_page()
    try:
      await stealth_async(page)
    except Exception:
      pass
    try:
      try:
        # 60s на карточку — на медленном мобильном прокси загрузка одной
        # карточки с рендером фото/отзывов/карты может занимать минуту.
        await page.goto(url, wait_until="domcontentloaded", timeout=60000)
      except PWTimeoutError:
        pass
      try:
        # Ждём заголовок до 30 сек — на скрине юзера иногда видно как
        # карточка "пустая" 15-20 сек прежде чем прорендерится.
        await page.wait_for_selector("h1, [class*='title']", timeout=30000)
      except PWTimeoutError:
        await asyncio.sleep(2)

      await self._click_show_phone(page)
      await self._expand_contacts(page)
      await asyncio.sleep(0.3)

      html = await page.content()
      soup = BeautifulSoup(html, "lxml")

      org.name = self._extract_name(soup)
      org.address, org.city, org.country = self._extract_address(soup)
      org.rating, org.reviews_count = self._extract_rating(soup)
      org.website = self._extract_website(soup)
      org.phone = self._extract_phone(soup)
      org.email = self._extract_email(soup)
      org.telegram, org.vk, org.instagram, org.whatsapp = self._extract_social(soup)
      org.working_hours = self._extract_working_hours(soup)
      org.categories = self._extract_categories(soup)
    except Exception as e:
      self.log(f"[!] Ошибка парсинга {url}: {e}")
    finally:
      try:
        await page.close()
      except Exception:
        pass
    return org

  async def _click_show_phone(self, page: Page):
    selectors = [
      "button[class*='phone']",
      "div[class*='phone'] button",
      "a[class*='phone']",
      "[class*='show-phone']",
      "[class*='card-phones'] button",
      "button[class*='contact']",
      "[data-type='phone']",
    ]
    for sel in selectors:
      try:
        buttons = await page.query_selector_all(sel)
      except Exception:
        continue
      for btn in buttons:
        try:
          if not await btn.is_visible():
            continue
          text = ((await btn.text_content()) or "").lower()
          if "телефон" in text or "показать" in text or "phone" in text or not text:
            try:
              await btn.click(timeout=1000)
              return
            except Exception:
              continue
        except Exception:
          continue

    # Общий фолбэк: любые кнопки с "телефон"/"показать" в тексте.
    try:
      buttons = await page.query_selector_all("button")
    except Exception:
      return
    for btn in buttons:
      try:
        if not await btn.is_visible():
          continue
        text = ((await btn.text_content()) or "").lower()
        if "телефон" in text or "показать" in text:
          try:
            await btn.click(timeout=1000)
            return
          except Exception:
            continue
      except Exception:
        continue

  async def _expand_contacts(self, page: Page):
    selectors = [
      "[class*='expand']",
      "[class*='more']",
      "button[class*='show-more']",
      "[class*='contacts'] button",
    ]
    for sel in selectors:
      try:
        elements = await page.query_selector_all(sel)
      except Exception:
        continue
      for elem in elements:
        try:
          if not await elem.is_visible():
            continue
          text = ((await elem.text_content()) or "").lower()
          if "ещё" in text or "еще" in text or "все" in text or "more" in text:
            try:
              await elem.click(timeout=1000)
            except Exception:
              continue
        except Exception:
          continue

  # ── extract-функции (чистый BeautifulSoup, не зависят от браузера) ──

  def _extract_links_from_soup(self, soup: BeautifulSoup) -> List[str]:
    found_links: set[str] = set()

    link_selectors = [
      ("a", {"class": re.compile(r"search-snippet-view__link")}),
      ("a", {"class": re.compile(r"search-business-snippet-view")}),
      ("a", {"class": re.compile(r"search-snippet-view")}),
      ("a", {"class": re.compile(r"card-title-view__title-link")}),
      ("a", {"class": re.compile(r"orgpage-header-view")}),
    ]

    for tag, attrs in link_selectors:
      for a in soup.find_all(tag, attrs):
        href = a.get("href", "")
        self._process_href(href, found_links)

    for a in soup.find_all("a", href=True):
      href = a.get("href", "")
      if "/org/" in href:
        self._process_href(href, found_links)

    for elem in soup.find_all(attrs={"data-log-id": True}):
      link = elem.find("a", href=True)
      if link:
        href = link.get("href", "")
        self._process_href(href, found_links)

    for a in soup.find_all("a", attrs={"aria-label": True}):
      href = a.get("href", "")
      if href:
        self._process_href(href, found_links)

    return list(found_links)

  def _process_href(self, href: str, found_links: set[str]):
    if not href:
      return
    if "/org/" not in href:
      return

    if href.startswith("/"):
      href = "https://yandex.ru" + href
    elif not href.startswith("http"):
      href = "https://yandex.ru/maps/" + href

    normalized = self._normalize_org_url(href)
    if normalized:
      found_links.add(normalized)

  def _normalize_org_url(self, url: str) -> str:
    if not url:
      return ""
    url = re.sub(r"https?://yandex\.(by|kz|ua|com)", "https://yandex.ru", url)
    match = re.search(r"(https://yandex\.ru/maps/org/[^/]+/\d+)", url)
    if match:
      return match.group(1) + "/"
    match = re.search(r"(https://yandex\.ru/org/[^/]+/\d+)", url)
    if match:
      return match.group(1).replace("/org/", "/maps/org/") + "/"
    return url

  def _extract_name(self, soup: BeautifulSoup) -> str:
    selectors = [
      "h1.orgpage-header-view__header",
      "h1.card-title-view__title",
      "h1[class*='title']",
      "span.card-title-view__title-text",
      "h1",
    ]
    for selector in selectors:
      elem = soup.select_one(selector)
      if elem:
        text = elem.get_text(strip=True)
        if text:
          return text
    return ""

  def _extract_address(self, soup: BeautifulSoup) -> tuple:
    address = ""
    city = ""
    country = ""

    selectors = [
      "[class*='address'] [class*='text']",
      "[itemprop='address']",
      "div.orgpage-header-view__address",
      "span.business-contacts-view__address-link",
      "a[class*='address']",
      "div[class*='address']",
    ]
    for selector in selectors:
      elem = soup.select_one(selector)
      if elem:
        address = elem.get_text(strip=True)
        if address:
          break

    if address:
      parts = address.split(",")
      if len(parts) >= 1:
        first_part = parts[0].strip()
        if first_part in ["Россия", "Russia", "Беларусь", "Казахстан", "Украина"]:
          country = first_part
          if len(parts) >= 2:
            city = parts[1].strip()
        else:
          city = first_part
          country = "Россия"

    return address, city, country

  def _extract_rating(self, soup: BeautifulSoup) -> tuple:
    rating = ""
    reviews = ""

    rating_selectors = [
      "span.business-rating-badge-view__rating-text",
      "div[class*='rating'] span",
      "[class*='rating-value']",
      "[class*='stars'] + span",
    ]
    for selector in rating_selectors:
      elem = soup.select_one(selector)
      if elem:
        text = elem.get_text(strip=True)
        match = re.search(r"[\d.,]+", text)
        if match:
          rating = match.group()
          break

    reviews_selectors = [
      "span.business-rating-badge-view__rating-count",
      "[class*='reviews-count']",
      "[class*='rating'] [class*='count']",
    ]
    for selector in reviews_selectors:
      elem = soup.select_one(selector)
      if elem:
        text = elem.get_text(strip=True)
        match = re.search(r"[\d\s]+", text)
        if match:
          reviews = match.group().replace(" ", "")
          break

    return rating, reviews

  def _extract_website(self, soup: BeautifulSoup) -> str:
    excluded_domains = [
      "yandex.ru", "yandex.by", "yandex.kz", "yandex.com", "ya.ru",
      "vk.com", "vk.me", "t.me", "telegram.me", "telegram.org",
      "instagram.com", "facebook.com", "fb.com", "wa.me", "whatsapp.com",
      "youtube.com", "youtu.be", "twitter.com", "x.com", "ok.ru",
      "odnoklassniki.ru",
    ]

    for a in soup.find_all("a", href=True):
      href = a.get("href", "")
      if "redirect" in href and "url=" in href:
        real_url = self._extract_real_url(href)
        if real_url and self._is_valid_website(real_url, excluded_domains):
          return real_url

    for a in soup.find_all("a", href=True):
      text = a.get_text(strip=True).lower()
      href = a.get("href", "")
      if re.match(r"^[a-z0-9\\-]+\\.[a-z]{2,}$", text) or ".ru" in text or ".com" in text:
        if not any(excl in text for excl in excluded_domains):
          real_url = self._extract_real_url(href)
          if real_url and self._is_valid_website(real_url, excluded_domains):
            return real_url
          if text.startswith("http"):
            return text
          if "." in text and not any(excl in text for excl in excluded_domains):
            return "https://" + text

    contact_selectors = ["[class*='contact']", "[class*='orgpage-header']", "[class*='business-contacts']"]
    for selector in contact_selectors:
      for block in soup.select(selector):
        for a in block.find_all("a", href=True):
          href = a.get("href", "")
          real_url = self._extract_real_url(href)
          if real_url and self._is_valid_website(real_url, excluded_domains):
            return real_url

    for a in soup.find_all("a", href=True):
      classes = " ".join(a.get("class", [])).lower()
      if any(x in classes for x in ["website", "site", "external", "link_type_web"]):
        real_url = self._extract_real_url(a.get("href", ""))
        if real_url and self._is_valid_website(real_url, excluded_domains):
          return real_url

    return ""

  def _extract_real_url(self, href: str) -> str:
    from urllib.parse import unquote

    if not href:
      return ""
    if "redirect" in href and "url=" in href:
      match = re.search(r"url=([^&]+)", href)
      if match:
        return unquote(match.group(1))
    if href.startswith("http") and "yandex" not in href:
      return href
    return ""

  def _is_valid_website(self, url: str, excluded_domains: list) -> bool:
    if not url or not url.startswith("http"):
      return False
    url_lower = url.lower()
    for domain in excluded_domains:
      if domain in url_lower:
        return False
    if "/maps/" in url_lower or "/org/" in url_lower:
      return False
    return True

  def _extract_phone(self, soup: BeautifulSoup) -> str:
    phones: list[str] = []

    for a in soup.find_all("a", href=True):
      href = a.get("href", "")
      if href.startswith("tel:"):
        phone = href.replace("tel:", "").strip()
        phone = re.sub(r"[^\d\+\-\(\)\s]", "", phone)
        if phone and len(phone) >= 7 and phone not in phones:
          phones.append(phone)

    phone_selectors = [
      "[class*='phone']",
      "[class*='tel']",
      "[class*='contact'] [class*='value']",
      "[class*='card-phones']",
      "[class*='business-contacts-view__phone']",
    ]
    for selector in phone_selectors:
      for elem in soup.select(selector):
        text = elem.get_text(strip=True)
        phone_matches = re.findall(r"[\+]?[\d][\d\s\-\(\)]{6,}[\d]", text)
        for phone in phone_matches:
          phone = phone.strip()
          if phone and len(phone) >= 7 and phone not in phones:
            phones.append(phone)

    contact_blocks = soup.find_all(class_=re.compile(r"contact|orgpage|business"))
    for block in contact_blocks:
      text = block.get_text()
      phone_matches = re.findall(r"(?:\+7|8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}", text)
      for phone in phone_matches:
        phone = phone.strip()
        if phone and phone not in phones:
          phones.append(phone)

    return "; ".join(phones[:5])

  def _extract_email(self, soup: BeautifulSoup) -> str:
    for a in soup.find_all("a", href=True):
      href = a.get("href", "")
      if href.startswith("mailto:"):
        return href.replace("mailto:", "").split("?")[0].strip()

    text = soup.get_text()
    email_pattern = r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"
    match = re.search(email_pattern, text)
    if match:
      return match.group()
    return ""

  def _extract_social(self, soup: BeautifulSoup) -> tuple:
    from urllib.parse import unquote

    telegram = ""
    vk = ""
    instagram = ""
    whatsapp = ""

    yandex_official = [
      "t.me/mapsyandex",
      "vk.com/yandex.maps",
      "vk.com/yandexmaps",
      "instagram.com/yandexmaps",
      "instagram.com/yandex.maps",
      "t.me/yandex",
      "vk.com/yandex",
    ]

    social_blocks = soup.find_all(class_=re.compile(r"social|contact|link|orgpage"))
    all_links = []
    for block in social_blocks:
      all_links.extend(block.find_all("a", href=True))
    all_links.extend(soup.find_all("a", href=True))

    for a in all_links:
      href = a.get("href", "")
      real_url = href
      if "redirect" in href and "url=" in href:
        match = re.search(r"url=([^&]+)", href)
        if match:
          real_url = unquote(match.group(1))

      real_url_lower = real_url.lower()
      if any(official in real_url_lower for official in yandex_official):
        continue

      if not telegram and ("t.me/" in real_url_lower or "telegram.me/" in real_url_lower):
        if re.search(r"t\.me/[a-zA-Z0-9_]+", real_url_lower):
          telegram = real_url
      elif not vk and ("vk.com/" in real_url_lower or "vk.me/" in real_url_lower):
        if re.search(r"vk\.com/[a-zA-Z0-9_\.]+", real_url_lower):
          vk = real_url
      elif not instagram and "instagram.com/" in real_url_lower:
        if re.search(r"instagram\.com/[a-zA-Z0-9_\.]+", real_url_lower):
          instagram = real_url
      elif not whatsapp and ("wa.me/" in real_url_lower or "whatsapp.com/" in real_url_lower):
        whatsapp = real_url

    return telegram, vk, instagram, whatsapp

  def _extract_working_hours(self, soup: BeautifulSoup) -> str:
    selectors = ["[class*='hours'] [class*='text']", "[class*='schedule']", "[class*='working-hours']"]
    for selector in selectors:
      elem = soup.select_one(selector)
      if elem:
        text = elem.get_text(strip=True)
        if text:
          return text[:200]
    return ""

  def _extract_categories(self, soup: BeautifulSoup) -> str:
    categories: list[str] = []
    selectors = ["[class*='category'] a", "[class*='rubric']", "a[href*='/rubric/']"]
    for selector in selectors:
      for elem in soup.select(selector):
        text = elem.get_text(strip=True)
        if text and text not in categories:
          categories.append(text)
    return ", ".join(categories[:5])
