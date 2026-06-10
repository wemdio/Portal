"""
Minimal task scheduler — reconcile + Poisson-slot planner.

Upstream OpenOutreach делает это в `linkedin/tasks/scheduler.py` — там полная
реализация с `working_seconds_in_window` и order-statistic Poisson'ом. Мы
импортируем оттуда основные функции, но обвешиваем их per-(account, campaign)
фильтрацией, потому что upstream'овский reconcile рассчитан на один
"глобальный" SiteConfig.

На текущем этапе (stub-handler'ы, нет реальных Voyager-вызовов) reconcile
просто гарантирует, что у каждого running'ового (account × campaign)
существует хотя бы один pending task в ближайшие 24 часа. Точная Poisson-
распределённость прийдёт со следующей итерацией реальных handler'ов.
"""
from __future__ import annotations

import logging
import random
from datetime import datetime, timedelta, timezone
from uuid import UUID

from asgiref.sync import sync_to_async
from django.db import close_old_connections

from li2.models import Campaign, Task

logger = logging.getLogger('li2.scheduler')

# Сколько task'ов планировать на 24h окно для одной (account × campaign × type)
# пары. Реальные числа берутся из PortalSettings.{connect,follow_up}_daily_limit
# когда дойдём до real impl; пока — sane defaults для smoke-test.
DEFAULT_TASKS_PER_TYPE_PER_DAY = {
    'connect': 5,
    'follow_up': 3,
    'check_pending': 8,
}


def _poisson_slot_times(now: datetime, n: int, horizon_hours: int = 24) -> list[datetime]:
    """
    Uniform order-statistic: n точек, равномерно распределённых на интервале
    [now, now + horizon_hours]. Среднее spacing = horizon / (n+1). Это
    upstream-approach из `linkedin/tasks/scheduler.py`. Real impl ещё учитывает
    working_hours, мы пока без.
    """
    if n <= 0:
        return []
    horizon_sec = horizon_hours * 3600
    fractions = sorted(random.random() for _ in range(n))
    return [now + timedelta(seconds=int(f * horizon_sec)) for f in fractions]


@sync_to_async
def _pending_count(account_id: UUID, campaign_id: UUID, task_type: str) -> int:
    return Task.objects.filter(
        account_id=account_id, campaign_id=campaign_id,
        type=task_type, status='pending',
    ).count()


@sync_to_async
def _create_tasks(rows: list[dict]) -> int:
    if not rows:
        return 0
    Task.objects.bulk_create([Task(**r) for r in rows])
    close_old_connections()
    return len(rows)


@sync_to_async
def _campaigns_for_account(user_id: UUID) -> list[Campaign]:
    return list(Campaign.objects.filter(user_id=user_id, status='running'))


async def reconcile(*, account_id: UUID, user_id: UUID) -> None:
    """
    Если у running-кампании пусто в pending — наполняем queue Poisson'ом.

    Идемпотентно: запускается на каждой итерации AccountWorker'а; ничего не
    делает, если в queue уже что-то есть.
    """
    campaigns = await _campaigns_for_account(user_id)
    if not campaigns:
        return

    now = datetime.now(timezone.utc)
    rows: list[dict] = []
    for camp in campaigns:
        for task_type, default_n in DEFAULT_TASKS_PER_TYPE_PER_DAY.items():
            existing = await _pending_count(account_id, camp.id, task_type)
            if existing > 0:
                continue
            slot_times = _poisson_slot_times(now, default_n)
            for t in slot_times:
                rows.append({
                    'user_id': user_id,
                    'account_id': account_id,
                    'campaign_id': camp.id,
                    'type': task_type,
                    'status': 'pending',
                    'scheduled_at': t,
                    'payload': {'campaign_id': str(camp.id)},
                })

    if rows:
        n = await _create_tasks(rows)
        logger.info('Reconcile: created %d new pending tasks for account=%s', n, account_id)
