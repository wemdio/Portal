"""
Task executor.

Принимает Task-строку из li2_tasks, проверяет, что мы ВНУТРИ working_hours
кампании, помечает running → дёргает handler → помечает completed/failed.

Handlers (`linkedin.portal_daemon.handlers.*`) — это thin адаптеры над
upstream'овскими task handlers (`linkedin/tasks/handle_*`). В первой
итерации daemon'a они — заглушки, которые просто пишут лог и помечают task
completed. Реальная интеграция с upstream (Voyager API, GPR scoring,
qualification LLM) — следующая итерация.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from asgiref.sync import sync_to_async
from django.db import close_old_connections
from playwright.async_api import BrowserContext

from li2.models import Campaign, PortalLog, Task

from . import handlers
from .exceptions import WorkingHoursViolation
from .working_hours import is_within, next_window_open

logger = logging.getLogger('li2.executor')

HANDLERS = {
    'connect': handlers.handle_connect,
    'check_pending': handlers.handle_check_pending,
    'follow_up': handlers.handle_follow_up,
}


@sync_to_async
def _mark(task_id, **kwargs) -> None:
    Task.objects.filter(id=task_id).update(**kwargs)
    close_old_connections()


@sync_to_async
def _get_campaign(campaign_id) -> Campaign | None:
    return Campaign.objects.filter(id=campaign_id).first()


async def execute_task(task: Task, ctx: BrowserContext) -> None:
    """
    Главный entry point AccountWorker'а после открытия browser_session.
    Один вызов = один task. Сам browser_session уже взял semaphore и
    держит Chromium открытым; executor отвечает только за state machine
    конкретной задачи.
    """
    handler = HANDLERS.get(task.type)
    if handler is None:
        await _mark(task.id, status='failed', error_message=f'unknown type: {task.type}',
                    completed_at=datetime.now(timezone.utc))
        return

    campaign = await _get_campaign(task.campaign_id)
    if campaign is None:
        await _mark(task.id, status='failed', error_message='campaign not found',
                    completed_at=datetime.now(timezone.utc))
        return

    # Working-hours check ДО mark'a running. Если за окном — перепланируем.
    now_utc = datetime.now(timezone.utc)
    if not is_within(campaign.working_hours, campaign.timezone_offset, now_utc):
        new_at = next_window_open(campaign.working_hours, campaign.timezone_offset, now_utc)
        await _mark(task.id, scheduled_at=new_at, status='pending')
        logger.info(
            'Task %s (%s) deferred to %s (outside working_hours %s utc%+d)',
            task.id, task.type, new_at, campaign.working_hours, campaign.timezone_offset,
        )
        return

    await _mark(task.id, status='running', started_at=now_utc)
    try:
        await handler(task, campaign, ctx)
        await _mark(task.id, status='completed', completed_at=datetime.now(timezone.utc))
    except WorkingHoursViolation:
        # На случай race: пока мы стартовали task, окно успело закрыться.
        # Перепланируем а не failed.
        new_at = next_window_open(campaign.working_hours, campaign.timezone_offset, datetime.now(timezone.utc))
        await _mark(task.id, status='pending', scheduled_at=new_at, started_at=None)
        logger.info('Task %s deferred mid-flight to %s', task.id, new_at)
    except Exception as e:
        logger.exception('Task %s (%s) failed', task.id, task.type)
        await _mark(
            task.id, status='failed',
            error_message=str(e)[:1000],
            completed_at=datetime.now(timezone.utc),
        )
        # PortalLog для UI
        await sync_to_async(PortalLog.error)(
            user_id=task.user_id,
            campaign_id=task.campaign_id,
            message=f'Task {task.type} failed: {e}',
            details={'task_id': str(task.id)},
        )
        # Re-raise чтобы AccountWorker мог поймать CaptchaDetected / AuthError
        raise
