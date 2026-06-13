"""
Ephemeral Playwright Chromium context per task.

Loading storage_state из Postgres → запуск Chromium → выполнение task'a →
сохранение storage_state обратно → закрытие Chromium.

Per-account proxy_url из li2_settings. LinkedIn ban-detection смотрит ASN,
без residential proxy на per-account уровне 1 акт не выживает дольше пары
дней — так что прокси обязателен.
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator
from uuid import UUID

from asgiref.sync import sync_to_async
from django.db import close_old_connections
from playwright.async_api import BrowserContext, async_playwright
from playwright_stealth import Stealth

from li2.models import BrowserSession, PortalSettings

from .exceptions import ProxyConfigError

logger = logging.getLogger('li2.browser')

# Anti-detection: патчим navigator.webdriver, chrome.runtime, plugins, webgl и
# т.д., чтобы headless Chromium не палился как бот (LinkedIn → /checkpoint).
# navigator_platform_override='Win32' (дефолт) совпадает с нашим Windows-UA.
# Инстанс stateless — переиспользуем на все сессии.
_STEALTH = Stealth()

# Playwright proxy поддерживает схемы http/https/socks4/socks5. Chromium НЕ
# умеет авторизацию (user/pass) для socks4/socks5 — только для http(s).
_PLAYWRIGHT_PROXY_SCHEMES = ('http', 'https', 'socks4', 'socks5')

# Headless по умолчанию (prod). Для прохождения CAPTCHA через VNC оператор
# выставляет LI2_BROWSER_HEADLESS=false — тогда Chromium рисует на Xvfb :99,
# который шарит x11vnc (см. compose/linkedin/start, ENABLE_VNC=true).
_HEADLESS = os.environ.get('LI2_BROWSER_HEADLESS', 'true').strip().lower() not in (
    'false', '0', 'no', 'off',
)


def parse_proxy_url(raw: str | None) -> dict | None:
    """
    proxy_url из li2_settings → Playwright proxy-dict
    `{'server': 'scheme://host:port', 'username'?: ..., 'password'?: ...}`.

    Поддержанные форматы:
      - `scheme://host:port`
      - `scheme://user:pass@host:port`
      - `scheme://host:port:user:pass`   (ip:port:user:pass из proxy-листов)
      - `host:port[:user:pass]`          (без схемы → http)

    Пустая строка → None (прокси не задан, caller решает что делать).
    Битый формат или socks+auth (Chromium не умеет) → ProxyConfigError.
    """
    proxy = (raw or '').strip()
    if not proxy:
        return None

    if '://' in proxy:
        scheme, _, rest = proxy.partition('://')
        scheme = scheme.lower()
    else:
        scheme, rest = 'http', proxy

    if scheme not in _PLAYWRIGHT_PROXY_SCHEMES:
        raise ProxyConfigError(
            f'Неподдерживаемая схема прокси "{scheme}". '
            f'Допустимо: {", ".join(_PLAYWRIGHT_PROXY_SCHEMES)}.'
        )

    username: str | None = None
    password: str | None = None

    # creds@host:port
    if '@' in rest:
        creds, _, hostport = rest.rpartition('@')
        username, _, password = creds.partition(':')
    else:
        hostport = rest

    parts = hostport.split(':')
    if len(parts) == 2:
        host, port = parts
    elif len(parts) == 4 and username is None:
        # host:port:user:pass (proxy-лист формат)
        host, port, username, password = parts
    else:
        raise ProxyConfigError(
            f'Не разобрать proxy_url "{raw}". Ожидается '
            'scheme://host:port, scheme://user:pass@host:port или '
            'scheme://host:port:user:pass.'
        )

    host = host.strip()
    port = port.strip()
    if not host or not port.isdigit():
        raise ProxyConfigError(f'Битый host:port в proxy_url "{raw}".')

    if scheme in ('socks4', 'socks5') and (username or password):
        raise ProxyConfigError(
            'Chromium не поддерживает SOCKS-прокси с логином/паролем. '
            'Используйте HTTP-прокси: http://user:pass@host:port.'
        )

    result: dict = {'server': f'{scheme}://{host}:{port}'}
    if username:
        result['username'] = username
    if password:
        result['password'] = password
    return result


@sync_to_async
def _load_storage_state(account_id: UUID) -> dict | None:
    row = BrowserSession.objects.filter(account_id=account_id).first()
    return row.storage_state if row and row.storage_state else None


@sync_to_async
def _load_proxy(user_id: UUID) -> str | None:
    s = PortalSettings.objects.filter(user_id=user_id).first()
    if not s:
        return None
    proxy = (s.proxy_url or '').strip()
    return proxy or None


@sync_to_async
def _save_storage_state(account_id: UUID, user_id: UUID, state: dict) -> None:
    BrowserSession.objects.update_or_create(
        account_id=account_id,
        defaults={
            'user_id': user_id,
            'storage_state': state,
            'cookies': b'',  # cookies дублируются внутри storage_state.cookies
        },
    )
    close_old_connections()


@asynccontextmanager
async def browser_session(account_id: UUID, user_id: UUID) -> AsyncIterator[BrowserContext]:
    """
    Open Chromium с прокинутыми cookies и proxy, yield context.
    После выхода — сохранить state обратно и закрыть всё.

    Использование:
        async with browser_session(acc_id, user_id) as ctx:
            page = await ctx.new_page()
            await page.goto('https://www.linkedin.com/feed/')
            ...
    """
    storage_state = await _load_storage_state(account_id)
    # parse_proxy_url бросает ProxyConfigError на битом proxy_url — НЕ глотаем:
    # запуск без прокси означал бы LinkedIn-трафик с реального IP (бан).
    proxy = parse_proxy_url(await _load_proxy(user_id))

    launch_kwargs: dict = {
        'headless': _HEADLESS,
        # Базовые флаги: убираем automation-флаг, sandbox off для docker'a.
        # JS-level stealth (navigator.webdriver, plugins, webgl, ...) —
        # _STEALTH.apply_stealth_async(ctx) ниже.
        'args': [
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
        ],
    }
    if proxy:
        launch_kwargs['proxy'] = proxy

    async with async_playwright() as p:
        browser = await p.chromium.launch(**launch_kwargs)
        ctx_kwargs: dict = {
            'viewport': {'width': 1366, 'height': 768},
            'user_agent': (
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
            ),
        }
        if storage_state:
            ctx_kwargs['storage_state'] = storage_state
        ctx: BrowserContext = await browser.new_context(**ctx_kwargs)
        # Инжектим stealth init-скрипты в контекст — применяются ко всем
        # страницам, созданным ПОСЛЕ (наш caller делает ctx.new_page() далее).
        await _STEALTH.apply_stealth_async(ctx)
        try:
            yield ctx
            # Сохраняем актуальный state ТОЛЬКО на чистом выходе. На исключении
            # (CAPTCHA, AuthError) — НЕ сохраняем, чтобы не записать
            # потенциально повреждённое состояние.
            try:
                new_state = await ctx.storage_state()
                await _save_storage_state(account_id, user_id, new_state)
            except Exception:
                logger.exception('Failed to persist storage_state for account=%s', account_id)
        finally:
            try:
                await ctx.close()
            finally:
                await browser.close()
