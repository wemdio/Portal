"""
AccountWorker — per-account event loop. По одному на каждый running'овый
li2_accounts.id. Получает Task'ы из планировщика, открывает ephemeral
Chromium, прогоняет executor, обновляет heartbeat.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from uuid import UUID

from asgiref.sync import sync_to_async
from django.db import close_old_connections

from li2.models import Account, PortalLog, Task

from .browser_session import browser_session
from .exceptions import (
    AuthenticationError,
    CaptchaDetected,
    NoSettingsError,
    ProxyConfigError,
)
from .executor import execute_task
from .recovery import reset_stale_tasks
from .scheduler import reconcile

logger = logging.getLogger('li2.worker')

# Глобальный semaphore: сколько Chromium'ов одновременно может быть открыто
# во всех Worker'ах вместе. Кепнут от случайной RAM-bomb'ы, когда 20
# аккаунтов разом захотят выполнить task. Real value берётся из env.
MAX_CONCURRENT_BROWSERS = int(os.environ.get('LI2_MAX_CONCURRENT_BROWSERS', '3'))
_BROWSER_SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT_BROWSERS)

IDLE_SLEEP_SEC = 60  # сон когда нет due task'ов
ERROR_SLEEP_SEC = 30  # сон на необработанной ошибке


class AccountWorker:
    """
    Один Worker на один Account. После `start()` крутит asyncio.Task до тех
    пор, пока `stop()` не выставит event.
    """

    def __init__(self, account_id: UUID, user_id: UUID):
        self.account_id = account_id
        self.user_id = user_id
        self._stop_event = asyncio.Event()
        self.task: asyncio.Task | None = None

    def start(self) -> None:
        if self.task and not self.task.done():
            return
        self.task = asyncio.create_task(self._run(), name=f'AccountWorker-{self.account_id}')

    def stop(self) -> None:
        self._stop_event.set()

    @sync_to_async
    def _heartbeat(self) -> None:
        Account.objects.filter(id=self.account_id).update(
            last_heartbeat_at=datetime.now(timezone.utc),
            runtime_status='running',
        )
        close_old_connections()

    @sync_to_async
    def _flag(self, status: str, message: str) -> None:
        Account.objects.filter(id=self.account_id).update(
            status=status,
            runtime_status=status,
            last_error=message,
            updated_at=datetime.now(timezone.utc),
        )
        close_old_connections()

    @sync_to_async
    def _pick_due_task(self) -> Task | None:
        now = datetime.now(timezone.utc)
        return (
            Task.objects
            .filter(account_id=self.account_id, status='pending', scheduled_at__lte=now)
            .order_by('scheduled_at')
            .first()
        )

    async def _run(self) -> None:
        logger.info('AccountWorker started: account=%s user=%s', self.account_id, self.user_id)
        await self._heartbeat()

        try:
            while not self._stop_event.is_set():
                try:
                    # 1. Reconcile planner: убеждаемся, что queue не пуст
                    await reconcile(account_id=self.account_id, user_id=self.user_id)

                    # 2. Pick next due task
                    task = await self._pick_due_task()
                    if task is None:
                        # Нет due task'ов — спим. Heartbeat обновляем редко, но
                        # обновляем чтобы UI видел "alive".
                        await self._heartbeat()
                        try:
                            await asyncio.wait_for(self._stop_event.wait(), timeout=IDLE_SLEEP_SEC)
                        except asyncio.TimeoutError:
                            pass
                        continue

                    # 3. Execute under global browser-semaphore
                    async with _BROWSER_SEMAPHORE:
                        async with browser_session(self.account_id, self.user_id) as ctx:
                            await execute_task(task, ctx)
                    await self._heartbeat()

                except CaptchaDetected as e:
                    logger.warning('CAPTCHA: account=%s', self.account_id)
                    await self._flag('needs_captcha', f'CAPTCHA: open VNC :6080 to resolve. {e}')
                    await sync_to_async(PortalLog.warning)(
                        user_id=self.user_id,
                        message='LinkedIn CAPTCHA detected — open VNC and resolve, then call /accounts/resume-from-captcha',
                    )
                    return  # Worker завершается, MainLoop его не перезапустит пока status != 'running'

                except AuthenticationError as e:
                    logger.error('AuthError: account=%s: %s', self.account_id, e)
                    await self._flag('disconnected', f'LinkedIn auth failure: {e}')
                    await sync_to_async(PortalLog.error)(
                        user_id=self.user_id,
                        message=f'LinkedIn auth disconnected: {e}',
                    )
                    return

                except ProxyConfigError as e:
                    logger.error('ProxyConfig: account=%s: %s', self.account_id, e)
                    await self._flag('disconnected', f'Битый прокси: {e}')
                    await sync_to_async(PortalLog.error)(
                        user_id=self.user_id,
                        message=f'Прокси настроен неверно: {e} '
                                'Исправьте proxy_url в /tools/li-outreach-v2 и переподключите.',
                    )
                    return

                except NoSettingsError:
                    logger.error('NoSettings: account=%s', self.account_id)
                    await sync_to_async(PortalLog.error)(
                        user_id=self.user_id,
                        message='No LinkedIn email/password configured — fill in /tools/li-outreach-v2 settings',
                    )
                    # Не флипаем status: settings обновятся через Portal UI,
                    # daemon переподнимется автоматически
                    await asyncio.sleep(IDLE_SLEEP_SEC)

                except Exception:
                    # Неизвестная ошибка — НЕ флипаем status (может быть
                    # transient), просто спим и пробуем заново.
                    logger.exception('Unexpected error in worker account=%s', self.account_id)
                    try:
                        await asyncio.wait_for(self._stop_event.wait(), timeout=ERROR_SLEEP_SEC)
                    except asyncio.TimeoutError:
                        pass
        finally:
            logger.info('AccountWorker stopped: account=%s', self.account_id)
            close_old_connections()


# Exposed для тестов:
__all__ = ['AccountWorker', 'reset_stale_tasks']
