"""
Daemon main loop — polls li2_accounts and dispatches AccountWorker per
running row. Sleep between polls = LI2_DAEMON_POLL_INTERVAL_SEC (default 5s).

Heartbeat: пишем mtime в /tmp/li2-daemon-heartbeat каждый итерацию.
Используется docker HEALTHCHECK'ом и autoheal sidecar'ом для перезапуска
залипшего daemon'a.

Стартует через `manage.py rundaemon` (см. linkedin/management/commands/rundaemon.py).
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import time
from pathlib import Path
from uuid import UUID

from asgiref.sync import sync_to_async
from django.db import close_old_connections

from li2.models import Account

from .account_worker import AccountWorker
from .recovery import reset_stale_tasks

logger = logging.getLogger('li2.main_loop')

POLL_INTERVAL_SEC = int(os.environ.get('LI2_DAEMON_POLL_INTERVAL_SEC', '5'))
HEARTBEAT_PATH = Path(os.environ.get('LI2_DAEMON_HEARTBEAT', '/tmp/li2-daemon-heartbeat'))


@sync_to_async
def _fetch_running() -> dict[UUID, UUID]:
    """Возвращает map account_id → user_id для всех running-аккаунтов."""
    result = {row.id: row.user_id for row in Account.objects.filter(status='running').only('id', 'user_id')}
    close_old_connections()
    return result


def _write_heartbeat() -> None:
    try:
        HEARTBEAT_PATH.write_text(str(int(time.time())))
    except OSError as e:
        # /tmp недоступен — не критично, autoheal перезапустит контейнер,
        # но логнём чтобы было видно в diagnostics.
        logger.warning('Failed to write heartbeat: %s', e)


async def main_loop(stop_event: asyncio.Event) -> None:
    """
    Главный poll loop. Workers — dict account_id → AccountWorker.

    Жизненный цикл:
    1. SELECT all running accounts
    2. Для новых (running, не в workers) — start AccountWorker
    3. Для ушедших (в workers, не running) — stop AccountWorker и удалить
    4. Heartbeat
    5. Recovery: reset_stale_tasks
    6. Sleep POLL_INTERVAL_SEC (или до stop_event)

    На shutdown — gracefully ждём всех AccountWorker'ов с разумным таймаутом.
    """
    workers: dict[UUID, AccountWorker] = {}
    logger.info(
        'main_loop started: poll_interval=%ds, heartbeat=%s',
        POLL_INTERVAL_SEC, HEARTBEAT_PATH,
    )

    while not stop_event.is_set():
        try:
            running = await _fetch_running()
        except Exception:
            logger.exception('Failed to fetch li2_accounts — retrying after sleep')
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=POLL_INTERVAL_SEC)
            except asyncio.TimeoutError:
                pass
            continue

        # 1. Стартуем новых
        for acc_id, user_id in running.items():
            if acc_id not in workers:
                w = AccountWorker(acc_id, user_id)
                w.start()
                workers[acc_id] = w
                logger.info('Spawned AccountWorker: account=%s user=%s', acc_id, user_id)

        # 2. Останавливаем ушедших
        for acc_id in list(workers.keys()):
            if acc_id not in running:
                w = workers.pop(acc_id)
                w.stop()
                logger.info('Signalled stop to AccountWorker: account=%s', acc_id)

        # 3. Heartbeat
        _write_heartbeat()

        # 4. Recovery (запускается каждый poll, idempotent)
        try:
            await reset_stale_tasks()
        except Exception:
            logger.exception('reset_stale_tasks failed (non-fatal)')

        # 5. Sleep с прерыванием по stop
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=POLL_INTERVAL_SEC)
        except asyncio.TimeoutError:
            pass

    # ──────────── Shutdown ────────────
    logger.info('Shutdown requested, stopping %d workers', len(workers))
    for w in workers.values():
        w.stop()

    # Ждём максимум 60 секунд — потом форсим cancel. Это даёт текущим task'ам
    # шанс корректно закрыть Chromium и сохранить storage_state.
    pending_tasks = [w.task for w in workers.values() if w.task and not w.task.done()]
    if pending_tasks:
        try:
            await asyncio.wait_for(
                asyncio.gather(*pending_tasks, return_exceptions=True),
                timeout=60,
            )
        except asyncio.TimeoutError:
            logger.warning('Workers did not stop in 60s; cancelling forcefully')
            for t in pending_tasks:
                t.cancel()
            await asyncio.gather(*pending_tasks, return_exceptions=True)

    logger.info('main_loop stopped cleanly')


def run_forever() -> None:
    """Sync entry, вызывается из `manage.py rundaemon`."""
    stop_event = asyncio.Event()

    def _handler(*_):
        logger.info('Received signal, scheduling stop')
        stop_event.set()

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _handler)
        except (NotImplementedError, ValueError):
            # Windows / некоторые edge cases — fallback на signal.signal
            signal.signal(sig, _handler)

    try:
        loop.run_until_complete(main_loop(stop_event))
    finally:
        loop.close()
