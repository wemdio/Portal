"""
Task handlers — stub'ы первой итерации.

В upstream'е реальные handlers живут в `linkedin/tasks/handle_connect.py`,
`handle_follow_up.py`, `handle_check_pending.py` — и интенсивно зависят от
`AccountSession` объекта (один глобальный browser), `SiteConfig` (LLM creds)
и upstream'овских моделей `linkedin.Campaign`, `crm.Lead`, `crm.Deal`.

В нашем форке этот мост нужно строить заново: brand new код, который
принимает наши Portal-native модели + Playwright BrowserContext + LLM creds
из env-var, и зовёт правильные куски `linkedin_cli` (Voyager API) и
`linkedin/agents/` (LLM qualification).

На сегодня — заглушки, которые:
1. Логируют, что handler позвался
2. Пишут PortalLog для UI
3. Возвращают success

Этого хватает для smoke-test'а end-to-end pipeline'а (UI → Portal API →
li2_accounts.status='running' → daemon полл → AccountWorker → executor →
handler → PortalLog → UI видит лог). Реальная LinkedIn-логика — следующая
итерация, отдельным spec'ом и planom (ML, Voyager, browser-state-machine).
"""
from __future__ import annotations

import asyncio
import logging

from asgiref.sync import sync_to_async
from playwright.async_api import BrowserContext

from li2.models import Campaign, PortalLog, Task

logger = logging.getLogger('li2.handlers')


async def _stub_log(task: Task, message: str) -> None:
    await sync_to_async(PortalLog.info)(
        user_id=task.user_id,
        campaign_id=task.campaign_id,
        message=message,
        details={'task_id': str(task.id), 'task_type': task.type},
    )


async def handle_connect(task: Task, campaign: Campaign, ctx: BrowserContext) -> None:
    """
    STUB: invite outreach — поиск кандидата + отправка connect-request.

    Real impl roadmap:
    1. Найти не-pending Lead через GPR top-K (linkedin/ml/)
    2. Открыть его profile_url в Playwright
    3. Click "Connect" + ввод invite-note (jinja2-prompt с qualifiers context)
    4. Сохранить Deal с state='pending', записать ActionLog
    """
    logger.info('STUB handle_connect for task=%s campaign=%s', task.id, campaign.name)
    await _stub_log(task, f'[stub] connect task processed for campaign "{campaign.name}"')
    # Имитация: задержка чтобы LinkedIn anti-bot не тригернулся (на stub'е
    # неважно, на real impl — критично)
    await asyncio.sleep(0.5)


async def handle_check_pending(task: Task, campaign: Campaign, ctx: BrowserContext) -> None:
    """
    STUB: проверка PENDING-deals на acceptance.

    Real impl roadmap:
    1. SELECT * FROM li2_deals WHERE state='pending' AND user_id=... LIMIT N
    2. Для каждого: GET /voyager/.../connections/<urn> через linkedin_cli API
    3. Если accepted → state='connected', stamp next_check_pending_at=NULL
    4. Если no change → keep pending, обновить next_check_pending_at
    """
    logger.info('STUB handle_check_pending for task=%s campaign=%s', task.id, campaign.name)
    await _stub_log(task, f'[stub] check_pending task processed for campaign "{campaign.name}"')
    await asyncio.sleep(0.5)


async def handle_follow_up(task: Task, campaign: Campaign, ctx: BrowserContext) -> None:
    """
    STUB: follow-up message в LinkedIn-чате.

    Real impl roadmap:
    1. SELECT * FROM li2_deals WHERE state='connected' AND chat_summary
       нужно обновить (последний message > 3 дня)
    2. materialize_profile_summary_if_missing
    3. follow_up_agent.j2 prompt через LLM → текст сообщения
    4. Открыть LinkedIn-чат, отправить
    5. update li2_messages + li2_deals.chat_summary
    """
    logger.info('STUB handle_follow_up for task=%s campaign=%s', task.id, campaign.name)
    await _stub_log(task, f'[stub] follow_up task processed for campaign "{campaign.name}"')
    await asyncio.sleep(0.5)
