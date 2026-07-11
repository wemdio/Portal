import os
import random
import re
import time
from dataclasses import dataclass
from typing import Callable, List, Optional


class YandexBlockedError(Exception):
  """Raised when Yandex likely blocks the parser (captcha / anti-bot page).

  Detected when we can't extract organization names from several cards in a row —
  either the page didn't load, or Yandex served a captcha stub.
  """


PARSE_MIN_DELAY_SEC = float(os.environ.get("YANDEXMAPS_PARSE_MIN_DELAY_SEC", "1.5"))
PARSE_MAX_DELAY_SEC = float(os.environ.get("YANDEXMAPS_PARSE_MAX_DELAY_SEC", "3.0"))
PARSE_MAX_CONSECUTIVE_EMPTY = int(os.environ.get("YANDEXMAPS_PARSE_MAX_CONSECUTIVE_EMPTY", "5"))

from bs4 import BeautifulSoup
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait


# Свежий пул User-Agent'ов: Chrome 130-131 на Windows/Mac + мобильный Android,
# чтобы Яндекс не палил по стабильному fingerprint'у одного и того же UA.
# Обновлять раз в 3-6 мес — старые версии Chrome сами по себе триггерят подозрение.
USER_AGENT_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
]

# Реалистичные размеры окна — Яндекс может сверять с UA (мобильный UA + 1920×1080
# = очевидный бот). Пары подобраны под каждый UA-класс через выбор в _create_driver.
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

  def get_proxy_url(self) -> str:
    if not self.enabled or not self.host:
      return ""
    if self.username and self.password:
      return f"{self.protocol}://{self.username}:{self.password}@{self.host}:{self.port}"
    return f"{self.protocol}://{self.host}:{self.port}"

  def get_selenium_wire_options(self) -> dict:
    if not self.enabled:
      return {}
    proxy_url = self.get_proxy_url()
    return {
      "proxy": {
        "http": proxy_url,
        "https": proxy_url,
        "verify_ssl": False,
      }
    }


class YandexMapsParser:
  def __init__(
    self,
    proxy_settings: Optional[ProxySettings] = None,
    headless: bool = False,
    progress_callback: Optional[Callable[[int, int, str], None]] = None,
    log_callback: Optional[Callable[[str], None]] = None,
  ):
    self.proxy_settings = proxy_settings or ProxySettings()
    self.headless = headless
    self.progress_callback = progress_callback
    self.log_callback = log_callback
    self.driver = None
    self.is_running = False

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
      "\u274c": "[X]",
      "\u2705": "[OK]",
      "\U0001f50d": "[SEARCH]",
      "\u23f3": "[WAIT]",
      "\U0001f4cb": "[LIST]",
      "\U0001f504": "[SYNC]",
      "\u26a0\ufe0f": "[!]",
      "\u26a0": "[!]",
      "\u23f9\ufe0f": "[STOP]",
      "\u23f9": "[STOP]",
      "\U0001f680": "[START]",
      "\u2139\ufe0f": "[i]",
      "\u2139": "[i]",
    }
    result = text
    for emoji, replacement in emoji_map.items():
      result = result.replace(emoji, replacement)
    return result

  def update_progress(self, current: int, total: int, message: str = ""):
    if self.progress_callback:
      self.progress_callback(current, total, message)

  def _create_driver(self):
    """Создаёт браузер на undetected-chromedriver (маскирует признаки Selenium).

    Раньше был обычный selenium.webdriver + ручные патчи `navigator.webdriver`
    и `disable-blink-features=AutomationControlled` — Яндекс всё равно палил
    (SmartCaptcha сверяет десятки fingerprint-признаков: WebGL, Canvas,
    навигатор.plugins, порядок TLS-хендшейка). undetected-chromedriver
    патчит бинарь chromedriver, чтобы убрать почти все эти маркеры.

    Auth-прокси (наши резидентные с логином/паролем) идут через
    selenium-wire — он инжектит basic-auth в http-заголовок, не запуская
    диалог браузера, который в headless-режиме недоступен.
    """
    chrome_options = Options()

    if self.headless:
      chrome_options.add_argument("--headless=new")

    # Обязательные флаги для контейнерного Chromium.
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--disable-infobars")
    chrome_options.add_argument("--lang=ru-RU")
    # Не грузим картинки на уровне Blink — экономит трафик прокси
    # (обычно основная часть — аватарки и превью). DOM-парсинг картинки
    # не использует, все поля берём из текста и href'ов.
    chrome_options.add_argument("--blink-settings=imagesEnabled=false")

    # Рандомизация UA + window-size на каждую сессию. Мобильный UA пары'ится
    # с мобильным viewport'ом — иначе противоречие в самом User-Agent-Client-Hints
    # даёт Яндексу сигнал "это бот".
    ua = random.choice(USER_AGENT_POOL)
    is_mobile = "Mobile" in ua
    width, height = random.choice(WINDOW_SIZES_MOBILE if is_mobile else WINDOW_SIZES_DESKTOP)
    chrome_options.add_argument(f"--user-agent={ua}")
    chrome_options.add_argument(f"--window-size={width},{height}")

    chrome_bin = (os.environ.get("CHROME_BIN") or "").strip()
    if chrome_bin:
      chrome_options.binary_location = chrome_bin

    # Путь к системному chromedriver (Debian apt: /usr/bin/chromedriver).
    # Передаём явно, чтобы uc не пытался качать сам — в контейнере нет
    # интернета в build-time для webdriver_manager'а.
    driver_path = (os.environ.get("CHROMEDRIVER_PATH") or "").strip() or None
    for candidate in ("/usr/bin/chromedriver", "/usr/local/bin/chromedriver"):
      if driver_path:
        break
      if os.path.exists(candidate):
        driver_path = candidate

    if self.proxy_settings.enabled and self.proxy_settings.username:
      # Auth-прокси через seleniumwire.undetected_chromedriver — это его
      # официальная интеграция; обычный uc не умеет username:password.
      try:
        from seleniumwire import undetected_chromedriver as swuc

        seleniumwire_options = self.proxy_settings.get_selenium_wire_options()
        self.driver = swuc.Chrome(
          options=chrome_options,
          seleniumwire_options=seleniumwire_options,
          driver_executable_path=driver_path,
          browser_executable_path=chrome_bin or None,
          use_subprocess=True,
          headless=self.headless,
        )
        self._apply_traffic_savings()
        return
      except Exception as e:
        self.log(f"[!] seleniumwire+uc не стартовал ({e}), падаем на обычный uc без auth-прокси")

    if self.proxy_settings.enabled and self.proxy_settings.host:
      proxy_arg = f"--proxy-server={self.proxy_settings.protocol}://{self.proxy_settings.host}:{self.proxy_settings.port}"
      chrome_options.add_argument(proxy_arg)

    import undetected_chromedriver as uc
    self.driver = uc.Chrome(
      options=chrome_options,
      driver_executable_path=driver_path,
      browser_executable_path=chrome_bin or None,
      use_subprocess=True,
      headless=self.headless,
    )
    self._apply_traffic_savings()

  def _apply_traffic_savings(self):
    """Через CDP блокирует запросы к тяжёлым ресурсам — тайлы карты, аватарки,
    метрика/аналитика. HTML/JS/CSS оставляем: JS-фреймворк Яндекса рендерит
    список организаций динамически, без них DOM будет пустым.

    Экономит ~70-80% трафика прокси. Основная масса байт на карте Яндекса —
    это тайлы (десятки МБ на прокрутку) и картинки-превью в карточках.
    """
    if not self.driver:
      return
    blocked_urls = [
      # Тайлы карты — самый жирный источник трафика.
      "*core-renderer-tiles*",
      "*/tiles*",
      "*/services/tiles*",
      "*tile.maps.yandex.net*",
      "*sat*.maps.yandex.net*",
      "*vec*.maps.yandex.net*",
      # Аватарки и картинки-превью организаций.
      "*avatars.mds.yandex.net*",
      "*avatars.mdst.yandex.net*",
      "*yastatic.net/s3/*",
      # Метрика/аналитика/реклама — нам не нужно.
      "*mc.yandex.ru/metrika*",
      "*mc.yandex.ru/watch*",
      "*mc.webvisor*",
      "*an.yandex.ru*",
      "*yandexadexchange.net*",
      # Медиа — не грузим совсем.
      "*.mp4",
      "*.webm",
      "*.mp3",
      "*.ogg",
    ]
    try:
      self.driver.execute_cdp_cmd("Network.enable", {})
      self.driver.execute_cdp_cmd("Network.setBlockedURLs", {"urls": blocked_urls})
    except Exception as e:
      # Не критично: `--blink-settings=imagesEnabled=false` в опциях уже
      # покрывает базовый кейс с картинками. CDP — просто дополнительный
      # слой блокировки для тайлов/метрики.
      self.log(f"[!] CDP-блокировка недоступна: {e}")

  def stop(self):
    self.is_running = False
    self.log("[STOP] Остановка парсера...")

  def close(self):
    if self.driver:
      try:
        self.driver.quit()
      except Exception:
        pass
      self.driver = None

  def generate_search_url(self, query: str, city: str = "") -> str:
    from urllib.parse import quote

    search_query = f"{city} {query}".strip() if city else query
    encoded_query = quote(search_query)
    return f"https://yandex.ru/maps/?text={encoded_query}"

  def _page_looks_blocked(self) -> bool:
    """Определяет, показал ли Яндекс капчу/антибот вместо результатов.

    Проверяем и URL (редирект на showcaptcha), и содержимое страницы по
    специфичным маркерам SmartCaptcha — чтобы не ловить ложные срабатывания.
    """
    try:
      current_url = (self.driver.current_url or "").lower()
    except Exception:
      current_url = ""
    if "showcaptcha" in current_url or "checkcaptcha" in current_url:
      return True

    try:
      html = (self.driver.page_source or "").lower()
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

  def collect_organization_links(
    self,
    search_url: str,
    max_results: int = 5000,
    max_seconds: int = 480,
    on_links: Optional[Callable[[List[str], int], None]] = None,
  ) -> List[str]:
    self.is_running = True
    links: list[str] = []
    deadline = time.monotonic() + max_seconds

    try:
      if not self.driver:
        self._create_driver()

      self.driver.get(search_url)
      if self._page_looks_blocked():
        raise YandexBlockedError("Яндекс показал капчу при загрузке страницы поиска")
      try:
        WebDriverWait(self.driver, 10).until(
          EC.presence_of_element_located(
            (By.CSS_SELECTOR, "[class*='search-snippet'], [class*='search-list'], [class*='search-business']")
          )
        )
      except Exception:
        time.sleep(2)

      time.sleep(1)

      sidebar_scroll = None
      for _ in range(3):
        sidebar_scroll = self._find_sidebar_scroll()
        if sidebar_scroll:
          break
        time.sleep(1)

      if not sidebar_scroll:
        # Список организаций не загрузился — либо капча, либо пустая выдача.
        # Разделяем: капча => понятная ошибка, иначе — честный пустой результат.
        if self._page_looks_blocked():
          raise YandexBlockedError("Яндекс показал капчу (список организаций не загрузился)")
        soup = BeautifulSoup(self.driver.page_source, "lxml")
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

      links_set: set[str] = set()

      while len(links) < max_results and scroll_attempts < max_scroll_attempts and self.is_running and time.monotonic() < deadline:
        for _ in range(3):
          self._scroll_sidebar(sidebar_scroll)
          time.sleep(0.15)

        soup = BeautifulSoup(self.driver.page_source, "lxml")
        new_links = self._extract_links_from_soup(soup)

        batch: list[str] = []
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
          current_scroll_height = self.driver.execute_script("return arguments[0].scrollHeight", sidebar_scroll)
          current_scroll_top = self.driver.execute_script("return arguments[0].scrollTop", sidebar_scroll)
          client_height = self.driver.execute_script("return arguments[0].clientHeight", sidebar_scroll)
        except Exception:
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
            self._try_alternative_scroll(sidebar_scroll)
            time.sleep(0.5)

          if at_bottom and consecutive_same_height >= 5 and no_new_results_count >= 12:
            break

          if no_new_results_count >= 8:
            self._force_scroll_to_bottom(sidebar_scroll)
            time.sleep(0.3)
        else:
          no_new_results_count = 0
          consecutive_same_height = 0
          last_count = len(links)

        last_scroll_height = current_scroll_height

        if scroll_attempts % 3 == 0:
          self.update_progress(len(links), max_results, f"Найдено: {len(links)}")

        if len(links) >= max_results:
          break

        time.sleep(0.8 if no_new_results_count > 6 else 0.4)
        scroll_attempts += 1

      if time.monotonic() >= deadline:
        self.log(f"[!] Таймаут сбора ссылок ({max_seconds}с), собрано {len(links)}")

      return links[:max_results]
    except YandexBlockedError:
      raise
    except Exception as e:
      self.log(f"[X] Ошибка при сборе ссылок: {e}")
      return links[:max_results]
    finally:
      self.is_running = False

  def _try_alternative_scroll(self, element):
    try:
      self.driver.execute_script(
        "arguments[0].scrollTop = arguments[0].scrollHeight; arguments[0].dispatchEvent(new Event('scroll', { bubbles: true }));",
        element,
      )
      self.driver.execute_script(
        "document.querySelectorAll('[class*=\"scroll\"], [class*=\"sidebar\"]').forEach(function(c) { if (c.scrollHeight > c.clientHeight) { c.scrollTop = c.scrollHeight; c.dispatchEvent(new Event('scroll', { bubbles: true })); } });"
      )
    except Exception:
      pass

  def _force_scroll_to_bottom(self, element):
    try:
      self.driver.execute_script(
        "arguments[0].scrollTop = arguments[0].scrollHeight; arguments[0].dispatchEvent(new Event('scroll', { bubbles: true })); arguments[0].dispatchEvent(new WheelEvent('wheel', { deltaY: 5000 }));",
        element,
      )
      time.sleep(0.5)
    except Exception:
      pass

  def _find_sidebar_scroll(self):
    try:
      result = self.driver.execute_script(
        "var scrollContainer = document.querySelector('.scroll__container'); if (scrollContainer && scrollContainer.scrollHeight > scrollContainer.clientHeight) { return scrollContainer; } var sidebar = document.querySelector('[class*=\"sidebar-view__panel\"]') || document.querySelector('[class*=\"sidebar\"]'); if (sidebar) { var scrollables = sidebar.querySelectorAll('*'); var bestMatch = null; var maxHeight = 0; for (var i = 0; i < scrollables.length; i++) { var el = scrollables[i]; var style = window.getComputedStyle(el); if ((style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto') && el.scrollHeight > el.clientHeight && el.clientHeight > 200) { if (el.scrollHeight > maxHeight) { maxHeight = el.scrollHeight; bestMatch = el; } } } if (bestMatch) return bestMatch; } var allScrolls = document.querySelectorAll('[class*=\"scroll\"]'); for (var j = 0; j < allScrolls.length; j++) { var s = allScrolls[j]; if (s.scrollHeight > s.clientHeight && s.clientHeight > 200) { var rect = s.getBoundingClientRect(); if (rect.height > 300) { return s; } } } return null;"
      )
      if result:
        return result
    except Exception:
      pass

    selectors = [
      "div.scroll__container",
      "div[class*='scroll__container']",
      "div.sidebar-view__panel div[class*='scroll']",
      "div[class*='sidebar-view__panel'] > div",
      "div[class*='sidebar'] div[class*='scroll']",
      "div.search-list-view__list",
      "ul.search-list-view__list",
      "div[class*='search-list-view']",
      "div[class*='results'] div[class*='scroll']",
      "div.search-snippet-view",
    ]

    for selector in selectors:
      try:
        elements = self.driver.find_elements(By.CSS_SELECTOR, selector)
        for elem in elements:
          if elem.is_displayed():
            scroll_height = self.driver.execute_script("return arguments[0].scrollHeight", elem)
            client_height = self.driver.execute_script("return arguments[0].clientHeight", elem)
            if scroll_height > client_height and client_height > 150:
              return elem
      except Exception:
        continue
    return None

  def _scroll_sidebar(self, element):
    try:
      self.driver.execute_script(
        "arguments[0].scrollTop += arguments[1]; arguments[0].dispatchEvent(new Event('scroll', { bubbles: true }));",
        element,
        2000,
      )
    except Exception:
      try:
        self.driver.execute_script(
          "var sidebar = document.querySelector('[class*=\"sidebar\"]'); if (sidebar) { var scrollable = sidebar.querySelector('[class*=\"scroll\"]'); if (scrollable) { scrollable.scrollTop += 2000; scrollable.dispatchEvent(new Event('scroll', { bubbles: true })); } }"
        )
      except Exception:
        pass

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

  def parse_organizations_from_links(self, links: List[str], max_seconds: int = 480) -> List[Organization]:
    self.is_running = True
    organizations: list[Organization] = []
    deadline = time.monotonic() + max_seconds
    consecutive_empty = 0

    try:
      if not self.driver:
        self._create_driver()

      for i, url in enumerate(links):
        if not self.is_running or time.monotonic() > deadline:
          break
        self.update_progress(i + 1, len(links), f"Парсинг: {i + 1}/{len(links)}")
        org = self.parse_organization(url)
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
        time.sleep(random.uniform(PARSE_MIN_DELAY_SEC, PARSE_MAX_DELAY_SEC))
      return organizations
    except YandexBlockedError:
      raise
    except Exception as e:
      self.log(f"[X] Критическая ошибка: {e}")
      return organizations
    finally:
      self.is_running = False

  def parse_organization(self, url: str) -> Organization:
    org = Organization(card_url=url)
    try:
      self.driver.get(url)
      try:
        WebDriverWait(self.driver, 5).until(EC.presence_of_element_located((By.CSS_SELECTOR, "h1, [class*='title']")))
      except TimeoutException:
        time.sleep(1)

      self._click_show_phone()
      self._expand_contacts()
      time.sleep(0.3)

      soup = BeautifulSoup(self.driver.page_source, "lxml")

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
    return org

  def _click_show_phone(self):
    try:
      phone_button_selectors = [
        "button[class*='phone']",
        "div[class*='phone'] button",
        "a[class*='phone']",
        "[class*='show-phone']",
        "[class*='card-phones'] button",
        "button[class*='contact']",
        "[data-type='phone']",
      ]
      for selector in phone_button_selectors:
        try:
          buttons = self.driver.find_elements(By.CSS_SELECTOR, selector)
          for btn in buttons:
            if btn.is_displayed():
              text = (btn.text or "").lower()
              if "телефон" in text or "показать" in text or "phone" in text or btn.text == "":
                btn.click()
                return
        except Exception:
          continue

      try:
        buttons = self.driver.find_elements(By.TAG_NAME, "button")
        for btn in buttons:
          if btn.is_displayed():
            text = (btn.text or "").lower()
            if "телефон" in text or "показать" in text:
              btn.click()
              return
      except Exception:
        pass
    except Exception:
      pass

  def _expand_contacts(self):
    try:
      expand_selectors = [
        "[class*='expand']",
        "[class*='more']",
        "button[class*='show-more']",
        "[class*='contacts'] button",
      ]
      for selector in expand_selectors:
        try:
          elements = self.driver.find_elements(By.CSS_SELECTOR, selector)
          for elem in elements:
            if elem.is_displayed():
              text = (elem.text or "").lower()
              if "ещё" in text or "еще" in text or "все" in text or "more" in text:
                elem.click()
        except Exception:
          continue
    except Exception:
      pass

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
      "yandex.ru",
      "yandex.by",
      "yandex.kz",
      "yandex.com",
      "ya.ru",
      "vk.com",
      "vk.me",
      "t.me",
      "telegram.me",
      "telegram.org",
      "instagram.com",
      "facebook.com",
      "fb.com",
      "wa.me",
      "whatsapp.com",
      "youtube.com",
      "youtu.be",
      "twitter.com",
      "x.com",
      "ok.ru",
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

