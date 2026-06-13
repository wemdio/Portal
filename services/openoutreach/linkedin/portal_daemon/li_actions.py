"""
LinkedIn Playwright primitives.

Прямой набор операций над LinkedIn'ом без upstream'овских Django dep'ов. Все
функции — async, принимают `BrowserContext` и работают с одной страницей
внутри него (создают/закрывают как нужно).

Селекторы рассчитаны на текущий публичный LinkedIn UI; будут ломаться при
A/B-вариантах. На каждый action — fallback по нескольким селекторам и
явное логирование "почему не сработало" (структура и semantics, не raw
HTML).
"""
from __future__ import annotations

import asyncio
import logging
import random
import re
from typing import TypedDict
from urllib.parse import quote

from playwright.async_api import BrowserContext, Page, TimeoutError as PWTimeout

from .exceptions import AuthenticationError, CaptchaDetected

logger = logging.getLogger('li2.actions')


# ─────────────── Anti-bot pacing ───────────────
# Human-like задержки между shaги. Базовые цифры от upstream'a OpenOutreach.
MIN_PAUSE_SEC = 1.5
MAX_PAUSE_SEC = 4.5
MIN_TYPE_DELAY_MS = 50
MAX_TYPE_DELAY_MS = 180


async def _pause(min_s: float = MIN_PAUSE_SEC, max_s: float = MAX_PAUSE_SEC) -> None:
    """Случайная пауза, чтобы не палиться bot-detection'у."""
    await asyncio.sleep(random.uniform(min_s, max_s))


async def _human_type(page: Page, selector: str, text: str) -> None:
    """Печать с переменной задержкой между нажатиями."""
    await page.click(selector)
    for ch in text:
        await page.keyboard.type(ch, delay=random.uniform(MIN_TYPE_DELAY_MS, MAX_TYPE_DELAY_MS))


async def _detect_blockers(page: Page) -> None:
    """
    Проверяет URL/контент на checkpoint, captcha, restricted-account и т.п.
    Бросает соответствующее исключение, которое поймает AccountWorker и
    флипнет li2_accounts.status.
    """
    url = page.url

    # /checkpoint/ — CAPTCHA или security challenge
    if '/checkpoint/' in url or '/check/' in url:
        raise CaptchaDetected(f'LinkedIn checkpoint page: {url}')

    # 401 redirect → /login или /uas/login
    if '/login' in url and 'session_redirect' in url:
        raise AuthenticationError(f'Redirected to login page: {url}')

    # Аккаунт restricted/banned
    try:
        content = await page.content()
    except Exception:
        return

    lowered = content.lower()
    if 'your account has been restricted' in lowered or 'account has been temporarily restricted' in lowered:
        raise AuthenticationError('Account restricted by LinkedIn')
    if "we couldn't verify" in lowered and 'identity' in lowered:
        raise CaptchaDetected('Identity verification required')


# ─────────────── Login ───────────────


async def is_logged_in(ctx: BrowserContext) -> bool:
    """Открывает /feed/ и проверяет, что не перекинуло на login."""
    page = await ctx.new_page()
    try:
        await page.goto('https://www.linkedin.com/feed/', wait_until='domcontentloaded', timeout=30000)
        await _pause(1, 2)
        await _detect_blockers(page)
        return '/feed' in page.url or '/in/' in page.url
    finally:
        await page.close()


async def login(ctx: BrowserContext, email: str, password: str) -> None:
    """
    Выполняет email+password login flow. Может уткнуться в CAPTCHA — бросает
    CaptchaDetected. Если уже залогинены — no-op (быстрая проверка).
    """
    if await is_logged_in(ctx):
        logger.info('Already logged in, skipping login flow')
        return

    page = await ctx.new_page()
    try:
        await page.goto('https://www.linkedin.com/login', wait_until='domcontentloaded', timeout=30000)
        await _pause(1, 2)
        await _detect_blockers(page)

        # Email input — фиксированный id уже годы
        await _human_type(page, '#username', email)
        await _pause(0.5, 1.5)
        await _human_type(page, '#password', password)
        await _pause(0.8, 2)

        # Click sign-in button
        await page.click('button[type="submit"]')
        await page.wait_for_load_state('domcontentloaded', timeout=30000)
        await _pause(2, 4)
        await _detect_blockers(page)

        if not ('/feed' in page.url or '/in/' in page.url or '/checkpoint/' in page.url):
            raise AuthenticationError(f'Login did not redirect to feed; URL={page.url}')

        # Double-check: post-login CAPTCHA
        await _detect_blockers(page)
        logger.info('Login flow completed')
    finally:
        await page.close()


# ─────────────── Profile scrape ───────────────


class ProfileInfo(TypedDict, total=False):
    public_identifier: str | None
    profile_url: str
    name: str
    first_name: str | None
    last_name: str | None
    position: str | None
    company: str | None
    urn: str | None


async def discover_profile(ctx: BrowserContext, profile_url: str) -> ProfileInfo | None:
    """
    Open profile and extract basic public info (name, headline, current company).
    Возвращает None если страница недоступна / 404. Бросает CaptchaDetected /
    AuthenticationError на соответствующих edge cases.

    Использует только DOM scraping (быстрее всего, не требует Voyager API).
    """
    page = await ctx.new_page()
    try:
        await page.goto(profile_url, wait_until='domcontentloaded', timeout=30000)
        await _pause(2, 4)
        await _detect_blockers(page)

        # Profile page should have h1 with the name
        try:
            name_locator = page.locator('h1').first
            await name_locator.wait_for(state='visible', timeout=10000)
            name = (await name_locator.inner_text()).strip()
        except PWTimeout:
            logger.warning('Profile page has no h1: %s', profile_url)
            return None

        info: ProfileInfo = {
            'profile_url': profile_url,
            'name': name,
        }

        # Split first/last name (LinkedIn shows full name in h1; not always reliable)
        parts = name.split(maxsplit=1)
        if parts:
            info['first_name'] = parts[0]
            if len(parts) > 1:
                info['last_name'] = parts[1]

        # Headline — обычно сразу под именем, div с classname-вариациями. Берём
        # первый non-h1 text node с заметной длиной.
        try:
            headline = await page.locator('.text-body-medium').first.inner_text(timeout=5000)
            info['position'] = headline.strip()
        except Exception:
            pass

        # public_identifier — из URL
        m = re.search(r'/in/([^/?#]+)', profile_url)
        if m:
            info['public_identifier'] = m.group(1)

        # urn — пытаемся вытащить из meta тэгов или ld+json
        try:
            urn_meta = await page.locator('meta[name*="urn"]').first.get_attribute('content', timeout=3000)
            if urn_meta and 'urn:li:fsd_profile:' in urn_meta:
                info['urn'] = urn_meta.split('urn:li:fsd_profile:')[1].split('"')[0]
        except Exception:
            pass

        return info
    except CaptchaDetected:
        raise
    except AuthenticationError:
        raise
    except Exception as e:
        logger.warning('Failed to discover profile %s: %s', profile_url, e)
        return None
    finally:
        await page.close()


# ─────────────── Connect (invite) ───────────────


class InviteResult(TypedDict):
    status: str  # 'sent' | 'already_connected' | 'pending' | 'no_button' | 'limit_reached'
    detail: str


async def send_invite(ctx: BrowserContext, profile_url: str, note: str | None = None) -> InviteResult:
    """
    Открывает профиль и отправляет connect request.

    Returns:
        {'status': 'sent', 'detail': '...'} — invite ушёл
        {'status': 'already_connected', ...} — уже first-degree connection
        {'status': 'pending', ...} — invite уже был отправлен ранее (Pending)
        {'status': 'no_button', ...} — нет кнопки Connect (out of network, etc.)
        {'status': 'limit_reached', ...} — weekly invite limit от LinkedIn
    """
    page = await ctx.new_page()
    try:
        await page.goto(profile_url, wait_until='domcontentloaded', timeout=30000)
        await _pause(2, 4)
        await _detect_blockers(page)

        # 1. Already connected?
        # Если кнопка Message видна в primary action area → 1st-degree
        for sel in [
            'button[aria-label^="Message"]',
            'a[aria-label^="Message"]',
        ]:
            count = await page.locator(sel).count()
            if count > 0:
                logger.info('Already connected (Message button visible): %s', profile_url)
                # NB: дополнительно убедимся, что это primary, а не "Message in chat"
                return {'status': 'already_connected', 'detail': 'Message button visible'}

        # 2. Connect button — primary location
        connect_clicked = False
        for sel in [
            'button:has-text("Connect")',
            'button[aria-label^="Invite"]',
            'div.entity-result__actions button:has-text("Connect")',
        ]:
            count = await page.locator(sel).count()
            if count > 0:
                try:
                    await page.locator(sel).first.click(timeout=5000)
                    connect_clicked = True
                    break
                except Exception as e:
                    logger.debug('Failed to click %s: %s', sel, e)

        if not connect_clicked:
            # Может быть в overflow menu (3 dots)
            try:
                more_btn = page.locator('button[aria-label^="More actions"]').first
                if await more_btn.count() > 0:
                    await more_btn.click(timeout=5000)
                    await _pause(0.5, 1.5)
                    # Now find Connect in dropdown
                    overflow_connect = page.locator('div[role="menu"] >> text=Connect').first
                    if await overflow_connect.count() > 0:
                        await overflow_connect.click(timeout=5000)
                        connect_clicked = True
            except Exception as e:
                logger.debug('Overflow menu Connect failed: %s', e)

        if not connect_clicked:
            logger.info('No Connect button found: %s', profile_url)
            return {'status': 'no_button', 'detail': 'Connect button not found in profile UI'}

        await _pause(1, 2)

        # 3. Возможно появилось модальное окно "How do you know X?". Часть
        # вариантов LinkedIn'a сразу шлёт invite без модалки, часть — с модалкой,
        # где есть "Add a note" + "Send" buttons.
        try:
            # Если есть note — добавляем
            if note:
                add_note_btn = page.locator('button:has-text("Add a note"), button:has-text("Add note")').first
                if await add_note_btn.count() > 0:
                    await add_note_btn.click(timeout=3000)
                    await _pause(0.5, 1)
                    # Textarea для note
                    note_area = page.locator('textarea[name="message"], textarea#custom-message').first
                    if await note_area.count() > 0:
                        await note_area.click()
                        # LinkedIn note limit = 200 chars
                        await page.keyboard.type(note[:200], delay=random.uniform(50, 150))
                        await _pause(0.5, 1)

            # Кликаем "Send" / "Send now" / "Send without a note"
            for send_sel in [
                'button[aria-label*="Send invitation"]',
                'button[aria-label*="Send now"]',
                'button:has-text("Send")',
            ]:
                send_btn = page.locator(send_sel).first
                if await send_btn.count() > 0:
                    await send_btn.click(timeout=5000)
                    await _pause(1, 2)
                    break
            else:
                # Модалки не было — invite уже ушёл по первому клику
                logger.debug('No send modal — invite went on first click')

        except Exception as e:
            logger.warning('Send-modal interaction failed: %s', e)

        # 4. Detect post-send LinkedIn responses
        await _pause(1, 2)

        # Проверяем на weekly limit
        try:
            content = await page.content()
            if 'reached the weekly invitation limit' in content.lower() or "you've reached the weekly" in content.lower():
                return {'status': 'limit_reached', 'detail': 'Weekly invite limit reached'}
        except Exception:
            pass

        await _detect_blockers(page)
        logger.info('Invite sent: %s', profile_url)
        return {'status': 'sent', 'detail': 'Invite request submitted'}

    finally:
        await page.close()


# ─────────────── Message ───────────────


async def send_message(ctx: BrowserContext, profile_url: str, message: str) -> bool:
    """
    Открывает чат с профилем и шлёт текстовое сообщение.

    Returns True если получилось, False — если кнопка Message недоступна
    (например, не 1st-degree connection).
    """
    page = await ctx.new_page()
    try:
        await page.goto(profile_url, wait_until='domcontentloaded', timeout=30000)
        await _pause(2, 4)
        await _detect_blockers(page)

        # Click Message button to open chat
        msg_btn = page.locator('button[aria-label^="Message"], a[aria-label^="Message"]').first
        if await msg_btn.count() == 0:
            logger.info('No Message button available: %s', profile_url)
            return False

        await msg_btn.click(timeout=10000)
        await _pause(1, 2)

        # Type message into the textarea in the popup
        textarea = page.locator(
            'div[role="dialog"] div[contenteditable="true"], div[aria-label*="Write a message"]'
        ).first
        await textarea.wait_for(state='visible', timeout=10000)
        await textarea.click()
        await page.keyboard.type(message, delay=random.uniform(40, 120))
        await _pause(0.5, 1.5)

        # Send
        send_btn = page.locator(
            'button:has-text("Send"), button[aria-label*="Send"]'
        ).first
        await send_btn.click(timeout=5000)
        await _pause(1, 2)
        await _detect_blockers(page)
        logger.info('Message sent: %s', profile_url)
        return True
    finally:
        await page.close()


# ─────────────── Read conversation thread ───────────────


class ThreadMessage(TypedDict):
    direction: str           # 'inbound' | 'outbound' | 'unknown'
    text: str
    external_id: str | None  # LinkedIn messagingMessage urn, если удалось вытащить


# Extract в один проход по DOM (надёжнее цепочки locator-вызовов). LinkedIn
# группирует сообщения по отправителю в .msg-s-message-group; внутри —
# .msg-s-event-listitem с телом в .msg-s-event-listitem__body и (иногда)
# data-event-urn. Селекторы текущего UI; нужна донастройка на живом аккаунте.
_THREAD_EXTRACT_JS = """
() => {
  const out = [];
  const groups = document.querySelectorAll('.msg-s-message-group');
  if (groups.length) {
    groups.forEach(g => {
      const a = g.querySelector('a.msg-s-message-group__profile-link, a[href*="/in/"]');
      const senderHref = a ? a.getAttribute('href') : null;
      const bodies = g.querySelectorAll('.msg-s-event-listitem__body, p.msg-s-message-group__message');
      const items = g.querySelectorAll('.msg-s-event-listitem');
      bodies.forEach((b, i) => {
        const li = items[i];
        out.push({
          senderHref,
          text: (b.innerText || b.textContent || '').trim(),
          urn: li ? (li.getAttribute('data-event-urn') || null) : null,
        });
      });
    });
  } else {
    document.querySelectorAll('.msg-s-event-listitem').forEach(li => {
      const a = li.querySelector('a[href*="/in/"]');
      const b = li.querySelector('.msg-s-event-listitem__body');
      out.push({
        senderHref: a ? a.getAttribute('href') : null,
        text: b ? (b.innerText || b.textContent || '').trim() : '',
        urn: li.getAttribute('data-event-urn') || null,
      });
    });
  }
  return out.filter(m => m.text);
}
"""


async def read_thread(
    ctx: BrowserContext, profile_url: str, lead_public_identifier: str | None,
) -> list[ThreadMessage]:
    """
    Открывает переписку с лидом (через ту же кнопку Message, что send_message) и
    возвращает сообщения треда в хронологическом порядке.

    Направление определяем по ссылке отправителя: если ведёт на профиль лида
    (`/in/<public_identifier>`) → inbound, иначе → outbound (наше). Если ссылку
    отправителя достать не удалось → 'unknown' (caller такие не записывает, но
    может показать в контексте LLM).

    Возвращает [] если кнопки Message нет (не 1st-degree) или тред не загрузился.
    """
    page = await ctx.new_page()
    try:
        await page.goto(profile_url, wait_until='domcontentloaded', timeout=30000)
        await _pause(2, 4)
        await _detect_blockers(page)

        msg_btn = page.locator('button[aria-label^="Message"], a[aria-label^="Message"]').first
        if await msg_btn.count() == 0:
            logger.info('read_thread: no Message button (not connected?): %s', profile_url)
            return []
        await msg_btn.click(timeout=10000)
        await _pause(1.5, 3)

        list_sel = (
            'div[role="dialog"] .msg-s-message-list-content, '
            '.msg-s-message-list-content, .msg-s-message-list'
        )
        try:
            await page.locator(list_sel).first.wait_for(state='visible', timeout=10000)
        except PWTimeout:
            logger.warning('read_thread: message list did not render: %s', profile_url)
            return []

        # Подгружаем историю — скроллим контейнер вверх несколько раз.
        for _ in range(4):
            await page.evaluate(
                "() => { const el = document.querySelector('.msg-s-message-list-content')"
                " || document.querySelector('.msg-s-message-list'); if (el && el.parentElement)"
                " el.parentElement.scrollTop = 0; }"
            )
            await _pause(0.6, 1.2)

        raw = await page.evaluate(_THREAD_EXTRACT_JS)
        await _detect_blockers(page)

        pid = (lead_public_identifier or '').strip().lower()
        messages: list[ThreadMessage] = []
        for m in raw:
            text = (m.get('text') or '').strip()
            if not text:
                continue
            href = (m.get('senderHref') or '').lower()
            if pid and pid in href:
                direction = 'inbound'
            elif href:
                direction = 'outbound'
            else:
                direction = 'unknown'
            messages.append({
                'direction': direction,
                'text': text,
                'external_id': m.get('urn') or None,
            })

        logger.info(
            'read_thread: %d messages (%d inbound) for %s',
            len(messages), sum(1 for x in messages if x['direction'] == 'inbound'), profile_url,
        )
        return messages
    except (CaptchaDetected, AuthenticationError):
        raise
    except Exception as e:
        logger.warning('read_thread failed for %s: %s', profile_url, e)
        return []
    finally:
        await page.close()


# ─────────────── Check pending ───────────────


async def list_my_sent_invitations(ctx: BrowserContext) -> list[str]:
    """
    Открывает /mynetwork/invitation-manager/sent/, scrape'ит public_identifier'ы
    тех, у кого invite ещё pending. Используется для check_pending — всё, что
    ушло из этого списка → значит accepted (или revoked).
    """
    page = await ctx.new_page()
    try:
        await page.goto(
            'https://www.linkedin.com/mynetwork/invitation-manager/sent/',
            wait_until='domcontentloaded',
            timeout=30000,
        )
        await _pause(2, 4)
        await _detect_blockers(page)

        # Scroll вниз чтобы подгрузились все pending (lazy-load)
        for _ in range(5):
            await page.evaluate('window.scrollBy(0, document.body.scrollHeight)')
            await _pause(0.8, 1.5)

        # Collect all profile links на странице
        links = await page.locator('a[href*="/in/"]').evaluate_all(
            'els => els.map(e => e.getAttribute("href"))'
        )
        public_ids: set[str] = set()
        for href in links:
            if not href:
                continue
            m = re.search(r'/in/([^/?#]+)', href)
            if m:
                public_ids.add(m.group(1))
        logger.info('Found %d pending invitations', len(public_ids))
        return sorted(public_ids)
    finally:
        await page.close()


# ─────────────── People search (discovery) ───────────────


async def search_people(ctx: BrowserContext, query: str, max_results: int = 10) -> list[str]:
    """
    People-search по ключевику → канонические profile URL'ы результатов.

    Открывает /search/results/people/?keywords=<query>, скроллит, собирает
    ссылки на профили (`a[href*="/in/"]` в карточках результатов), дедупит,
    возвращает до max_results штук в виде https://www.linkedin.com/in/<id>/.

    Селекторы публичного search-UI — будут ломаться при A/B, нужна донастройка
    на живом аккаунте. На ошибке возвращает [] (не валит discovery-таск).
    """
    page = await ctx.new_page()
    try:
        url = f'https://www.linkedin.com/search/results/people/?keywords={quote(query)}'
        await page.goto(url, wait_until='domcontentloaded', timeout=30000)
        await _pause(2, 4)
        await _detect_blockers(page)

        # Подгружаем результаты (lazy-load).
        for _ in range(4):
            await page.evaluate('window.scrollBy(0, document.body.scrollHeight)')
            await _pause(0.8, 1.6)

        hrefs = await page.locator('a[href*="/in/"]').evaluate_all(
            'els => els.map(e => e.getAttribute("href"))'
        )
        seen: set[str] = set()
        urls: list[str] = []
        for href in hrefs:
            if not href:
                continue
            m = re.search(r'/in/([^/?#]+)', href)
            if not m:
                continue
            pid = m.group(1)
            if pid in seen:
                continue
            seen.add(pid)
            urls.append(f'https://www.linkedin.com/in/{pid}/')
            if len(urls) >= max_results:
                break
        logger.info('search_people("%s"): %d profiles', query, len(urls))
        return urls
    except (CaptchaDetected, AuthenticationError):
        raise
    except Exception as e:
        logger.warning('search_people failed for "%s": %s', query, e)
        return []
    finally:
        await page.close()
