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

from li2.models import Campaign, Deal, PortalSettings, Task

logger = logging.getLogger('li2.scheduler')

# Статусы task'ов, которые отражают «запланированное или сделанное действие» —
# считаем их против дневного/недельного лимита. failed/cancelled не считаем
# (действие не состоялось).
_COUNTED_STATUSES = ('pending', 'running', 'completed')
FALLBACK_CONNECT_WEEKLY_LIMIT = 100

# Per-type defaults на случай отсутствующих PortalSettings (новый юзер,
# settings ещё не сохранён). check_pending не зависит от лимитов LinkedIn'а —
# это read-only check, всегда фикс. connect/follow_up — реальные ratе-
# limited операции, должны идти из PortalSettings.
FALLBACK_TASKS_PER_DAY = {
    'connect': 10,
    'follow_up': 15,
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


def _slots_to_create(n_per_day: int, daily_used: int, weekly_remaining: int | None = None) -> int:
    """
    Pure: сколько task'ов создать в этот reconcile, чтобы НЕ превысить лимиты.

    n_per_day        — суточный лимит (размер дневного батча).
    daily_used       — сколько task'ов этого типа уже создано за последние 24ч
                       (pending+running+completed). Жёсткий дневной потолок:
                       не даёт быстрому дренажу очереди вызвать второй батч в
                       тот же день.
    weekly_remaining — для connect: остаток недельного лимита инвайтов
                       (weekly_limit − создано за 7д). None для типов без
                       недельного лимита.
    """
    remaining = n_per_day - daily_used
    if weekly_remaining is not None:
        remaining = min(remaining, weekly_remaining)
    return max(0, remaining)


@sync_to_async
def _pending_count(account_id: UUID, campaign_id: UUID, task_type: str) -> int:
    return Task.objects.filter(
        account_id=account_id, campaign_id=campaign_id,
        type=task_type, status='pending',
    ).count()


@sync_to_async
def _created_since(account_id: UUID, campaign_id: UUID, task_type: str, since: datetime) -> int:
    """Сколько task'ов этого типа создано с момента `since` (для лимитов)."""
    return Task.objects.filter(
        account_id=account_id, campaign_id=campaign_id, type=task_type,
        status__in=_COUNTED_STATUSES, created_at__gte=since,
    ).count()


@sync_to_async
def _connect_weekly_limit(user_id: UUID) -> int:
    s = PortalSettings.objects.filter(user_id=user_id).first()
    if not s:
        return FALLBACK_CONNECT_WEEKLY_LIMIT
    return max(1, int(s.connect_weekly_limit or FALLBACK_CONNECT_WEEKLY_LIMIT))


@sync_to_async
def _refresh_campaign_runtime(campaign_id: UUID) -> None:
    """
    Демон-сторона li2_campaigns.runtime_status/stats: UI (page.tsx) показывает
    campaign.runtime_status, а раньше демон его НИКОГДА не обновлял — карточка
    вечно висела 'queued_for_openoutreach'. Считаем прогресс из Deal-состояний.
    """
    deals = Deal.objects.filter(campaign_id=campaign_id)
    total = deals.count()
    invited = deals.filter(state__in=['pending', 'connected', 'completed']).count()
    connected = deals.filter(state__in=['connected', 'completed']).count()
    now = datetime.now(timezone.utc)
    Campaign.objects.filter(id=campaign_id).update(
        runtime_status='running',
        stats={
            'leads': total, 'invited': invited, 'connected': connected,
            'updated_at': now.isoformat(),
        },
        last_sync_at=now,
    )
    close_old_connections()


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


@sync_to_async
def _per_type_limits(user_id: UUID) -> dict[str, int]:
    """Берём дневные лимиты из PortalSettings (UI-сторона), fallback на defaults."""
    s = PortalSettings.objects.filter(user_id=user_id).first()
    if not s:
        return dict(FALLBACK_TASKS_PER_DAY)
    return {
        'connect': max(1, int(s.connect_daily_limit or FALLBACK_TASKS_PER_DAY['connect'])),
        'follow_up': max(1, int(s.follow_up_daily_limit or FALLBACK_TASKS_PER_DAY['follow_up'])),
        'check_pending': FALLBACK_TASKS_PER_DAY['check_pending'],
    }


async def reconcile(*, account_id: UUID, user_id: UUID) -> None:
    """
    Если у running-кампании пусто в pending — наполняем queue Poisson'ом.

    Идемпотентно: запускается на каждой итерации AccountWorker'а; ничего не
    делает, если в queue уже что-то есть для данного task_type.

    N (сколько task'ов) берётся из PortalSettings.{connect,follow_up}_daily_limit.
    """
    campaigns = await _campaigns_for_account(user_id)
    if not campaigns:
        return

    limits = await _per_type_limits(user_id)
    weekly_connect_limit = await _connect_weekly_limit(user_id)
    now = datetime.now(timezone.utc)
    day_ago = now - timedelta(hours=24)
    week_ago = now - timedelta(days=7)
    rows: list[dict] = []
    for camp in campaigns:
        for task_type, n_per_day in limits.items():
            existing = await _pending_count(account_id, camp.id, task_type)
            if existing > 0:
                continue

            # Жёсткий дневной лимит: учитываем уже созданные за 24ч, а не только
            # размер очереди — иначе быстрый дренаж даёт лишний батч в тот же день.
            daily_used = await _created_since(account_id, camp.id, task_type, day_ago)
            weekly_remaining = None
            if task_type == 'connect':
                weekly_used = await _created_since(account_id, camp.id, task_type, week_ago)
                weekly_remaining = weekly_connect_limit - weekly_used

            n = _slots_to_create(n_per_day, daily_used, weekly_remaining)
            if n <= 0:
                logger.info(
                    'Reconcile: %s лимит исчерпан для campaign=%s (daily_used=%d, weekly_rem=%s), skip',
                    task_type, camp.id, daily_used, weekly_remaining,
                )
                continue

            slot_times = _poisson_slot_times(now, n)
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

        # Обновляем runtime_status/stats кампании (UI читает их) — каждую итерацию.
        await _refresh_campaign_runtime(camp.id)

    if rows:
        n = await _create_tasks(rows)
        logger.info('Reconcile: created %d new pending tasks for account=%s', n, account_id)
