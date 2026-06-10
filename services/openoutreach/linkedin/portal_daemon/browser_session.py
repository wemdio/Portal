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
from contextlib import asynccontextmanager
from typing import AsyncIterator
from uuid import UUID

from asgiref.sync import sync_to_async
from django.db import close_old_connections
from playwright.async_api import BrowserContext, async_playwright

from li2.models import BrowserSession, PortalSettings

logger = logging.getLogger('li2.browser')


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
    proxy = await _load_proxy(user_id)

    launch_kwargs: dict = {
        'headless': True,
        # Стандартный anti-detection минимум: убираем automation-флаг, sandbox
        # off для docker'a. Дальнейшие stealth-меры — через playwright-stealth
        # (см. upstream linkedin/browser/).
        'args': [
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
        ],
    }
    if proxy:
        launch_kwargs['proxy'] = {'server': proxy}

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
