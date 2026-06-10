"""
Crash-recovery для daemon'а.

При перезапуске контейнера остаются "висячие" tasks со status='running'
без heartbeat'a — их нужно сбросить обратно в 'pending', чтобы они
переисполнились новым AccountWorker'ом. Без этого pending-queue будет
"видимо пустой" (все задачи числятся выполняющимися), и daemon никогда не
заберёт новую — типичная failure-mode worker'ов в Portal'е.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from asgiref.sync import sync_to_async
from django.db import close_old_connections

from li2.models import Task

logger = logging.getLogger('li2.recovery')

# Tasks running > STALE_MINUTES без heartbeat считаются мёртвыми.
# 5 минут — больше, чем средняя длительность task'a (30-180s) с запасом.
STALE_MINUTES = 5


@sync_to_async
def _reset_stale_sync() -> int:
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=STALE_MINUTES)
    affected = Task.objects.filter(
        status='running',
        started_at__lt=cutoff,
    ).update(
        status='pending',
        started_at=None,
        error_message='Reset by daemon recovery (stale: no heartbeat)',
    )
    close_old_connections()
    return affected


async def reset_stale_tasks() -> int:
    """Возвращает число сброшенных tasks (для логирования)."""
    n = await _reset_stale_sync()
    if n:
        logger.info('Recovery: reset %d stale tasks back to pending', n)
    return n
