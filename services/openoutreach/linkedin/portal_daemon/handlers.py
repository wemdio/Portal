"""
Task handlers — реальные действия в LinkedIn.

Жизненный цикл одного "юзкейса":

1. handle_connect:
   - На первой задаче для running-аккаунта — login если нет storage_state
   - Если у кампании есть seed_profile_urls без Lead'ов — обрабатываем их
     (discover → создаём Lead+Deal qualified → шлём invite → Deal→pending)
   - Иначе берём существующий Deal(state='qualified') и шлём invite

2. handle_check_pending:
   - Откpываем /mynetwork/invitation-manager/sent — сканируем pending
   - Для каждого Deal(state='pending', updated_at > 24h ago):
     * Если public_identifier нет в sent → invitation accepted → state='connected'
     * Если есть → ещё pending, обновляем next_check_pending_at

3. handle_follow_up:
   - Берём Deal(state='connected', нет наших message за 3+ дня)
   - LLM генерит follow-up по кампании + chat_summary + последним N
     ChatMessage'ам (для начала просто templated/short — детальный mem0
     придёт со следующей итерацией)
   - Шлём сообщение → создаём ChatMessage(direction='outbound')
"""
from __future__ import annotations

import hashlib
import logging
import uuid
from datetime import datetime, timedelta, timezone

from asgiref.sync import sync_to_async
from django.db import close_old_connections
from playwright.async_api import BrowserContext

from li2.models import (
    Account,
    BrowserSession,
    Campaign,
    ChatMessage,
    Deal,
    Lead,
    PortalLog,
    PortalSettings,
    Task,
)

from . import li_actions
from .exceptions import NoSettingsError
from .llm import LLMError, complete as llm_complete, render_prompt

logger = logging.getLogger('li2.handlers')


# ─────────────── helpers ───────────────


@sync_to_async
def _get_settings(user_id: uuid.UUID) -> PortalSettings | None:
    s = PortalSettings.objects.filter(user_id=user_id).first()
    close_old_connections()
    return s


@sync_to_async
def _has_storage_state(account_id: uuid.UUID) -> bool:
    return BrowserSession.objects.filter(
        account_id=account_id, storage_state__isnull=False,
    ).exists()


@sync_to_async
def _campaign_qualifiers(campaign_id: uuid.UUID) -> dict:
    c = Campaign.objects.filter(id=campaign_id).first()
    if not c or not c.qualifiers:
        return {}
    qual_list = c.qualifiers if isinstance(c.qualifiers, list) else []
    if not qual_list:
        return {}
    q = qual_list[0]
    return q if isinstance(q, dict) else {}


@sync_to_async
def _seed_profile_urls(campaign_id: uuid.UUID) -> list[str]:
    """Возвращает seed URLs из qualifiers (туда их положил Portal /start)."""
    q = Campaign.objects.filter(id=campaign_id).only('qualifiers').first()
    if not q or not q.qualifiers:
        return []
    qual = q.qualifiers[0] if isinstance(q.qualifiers, list) and q.qualifiers else {}
    raw = qual.get('seed_profile_urls', [])
    if isinstance(raw, list):
        return [str(u).strip() for u in raw if str(u).strip()]
    return []


@sync_to_async
def _lead_for_url(user_id: uuid.UUID, campaign_id: uuid.UUID, profile_url: str) -> Lead | None:
    """Существующий Lead по (user_id, profile_url) для этой кампании."""
    return (
        Lead.objects
        .filter(user_id=user_id, profile_url=profile_url)
        .first()
    )


@sync_to_async
def _create_lead_and_deal(
    user_id: uuid.UUID,
    campaign_id: uuid.UUID,
    info: dict,
) -> tuple[Lead, Deal]:
    """Создаёт Lead + Deal(state='qualified') в одной транзакции."""
    from django.db import transaction

    with transaction.atomic():
        lead = Lead.objects.create(
            user_id=user_id,
            campaign_id=campaign_id,
            profile_url=info.get('profile_url') or '',
            public_identifier=info.get('public_identifier'),
            urn=info.get('urn'),
            name=info.get('name', ''),
            first_name=info.get('first_name'),
            last_name=info.get('last_name'),
            position=info.get('position'),
            state='qualified',
            meta={k: v for k, v in info.items() if v is not None},
        )
        deal = Deal.objects.create(
            user_id=user_id,
            campaign_id=campaign_id,
            lead_id=lead.id,
            state='qualified',
        )
        close_old_connections()
        return lead, deal


@sync_to_async
def _next_qualified_deal(user_id: uuid.UUID, campaign_id: uuid.UUID) -> tuple[Deal, Lead] | None:
    """Пик случайный (по сути — oldest) Deal qualified ещё не связанный."""
    deal = (
        Deal.objects
        .filter(user_id=user_id, campaign_id=campaign_id, state='qualified')
        .order_by('updated_at')
        .first()
    )
    if not deal:
        return None
    lead = Lead.objects.filter(id=deal.lead_id).first()
    if not lead:
        return None
    return deal, lead


@sync_to_async
def _mark_deal(deal_id: uuid.UUID, **kwargs) -> None:
    kwargs.setdefault('updated_at', datetime.now(timezone.utc))
    Deal.objects.filter(id=deal_id).update(**kwargs)
    close_old_connections()


@sync_to_async
def _mark_lead(lead_id: uuid.UUID, **kwargs) -> None:
    kwargs.setdefault('updated_at', datetime.now(timezone.utc))
    Lead.objects.filter(id=lead_id).update(**kwargs)
    close_old_connections()


@sync_to_async
def _log(user_id, campaign_id, level: str, msg: str, **details) -> None:
    method = getattr(PortalLog, level)
    method(user_id=user_id, campaign_id=campaign_id, message=msg, details=details or None)
    close_old_connections()


async def _ensure_logged_in(ctx: BrowserContext, user_id: uuid.UUID) -> None:
    """Проверяет логин, если нет storage_state — делает login flow."""
    if await li_actions.is_logged_in(ctx):
        return

    settings = await _get_settings(user_id)
    if not settings or not settings.linkedin_email or not settings.linkedin_password:
        raise NoSettingsError(f'PortalSettings missing creds for user={user_id}')

    logger.info('Performing login for user=%s', user_id)
    await li_actions.login(ctx, settings.linkedin_email, settings.linkedin_password)
    await _log(user_id, None, 'info', 'LinkedIn login successful')


# ─────────────── handle_connect ───────────────


async def handle_connect(task: Task, campaign: Campaign, ctx: BrowserContext) -> None:
    """
    Один invite per task. Логика:

    1. Ensure logged in
    2. Если seed_profile_urls у кампании есть и среди них есть URL без Lead'а —
       discover'им один, создаём Lead+Deal, шлём invite.
    3. Иначе берём первый Deal(qualified) и шлём ему invite.
    4. На любом результате (sent / no_button / etc.) — обновляем state и
       пишем PortalLog для UI.
    """
    await _ensure_logged_in(ctx, task.user_id)

    # Поиск незаюзанного seed URL
    seeds = await _seed_profile_urls(task.campaign_id)
    target_url: str | None = None
    target_deal: Deal | None = None
    target_lead: Lead | None = None
    info: dict | None = None

    for url in seeds:
        existing = await _lead_for_url(task.user_id, task.campaign_id, url)
        if existing is None:
            # Новый seed → discover + create
            info = await li_actions.discover_profile(ctx, url)
            if info is None:
                await _log(
                    task.user_id, task.campaign_id, 'warning',
                    f'Seed URL inaccessible: {url}',
                )
                continue
            target_lead, target_deal = await _create_lead_and_deal(
                task.user_id, task.campaign_id, info,
            )
            target_url = url
            await _log(
                task.user_id, task.campaign_id, 'info',
                f'Discovered seed lead: {info.get("name", "?")} @ {url}',
                lead_id=str(target_lead.id), deal_id=str(target_deal.id),
            )
            break

    if target_deal is None:
        # Все seed'ы уже discovered → берём из qualified pool
        pair = await _next_qualified_deal(task.user_id, task.campaign_id)
        if pair is None:
            await _log(
                task.user_id, task.campaign_id, 'info',
                'No qualified leads to connect with (queue empty)',
            )
            return
        target_deal, target_lead = pair
        target_url = target_lead.profile_url

    if not target_url:
        await _log(
            task.user_id, task.campaign_id, 'warning',
            'Target Deal has no profile_url, skipping',
        )
        await _mark_deal(target_deal.id, state='failed', outcome='unknown')
        return

    # Готовим invite note (LinkedIn limit ~ 200 chars). Берём из qualifiers,
    # подставляем имя.
    qual = await _campaign_qualifiers(task.campaign_id)
    note: str | None = None
    invite_template = (qual.get('invite_note') or '').strip()
    if invite_template:
        note = render_prompt(
            invite_template,
            first_name=(target_lead.first_name or target_lead.name or '').split()[0] if target_lead.name else '',
            name=target_lead.name or '',
            position=target_lead.position or '',
        )

    # Send the invite
    result = await li_actions.send_invite(ctx, target_url, note=note)

    if result['status'] == 'sent':
        await _mark_deal(target_deal.id, state='pending', next_check_pending_at=datetime.now(timezone.utc) + timedelta(days=2))
        await _mark_lead(target_lead.id, state='pending')
        await _log(
            task.user_id, task.campaign_id, 'info',
            f'Invite sent to {target_lead.name or target_lead.public_identifier}',
            lead_id=str(target_lead.id), profile_url=target_url, has_note=bool(note),
        )
    elif result['status'] == 'already_connected':
        await _mark_deal(target_deal.id, state='connected')
        await _mark_lead(target_lead.id, state='connected')
        await _log(
            task.user_id, task.campaign_id, 'info',
            f'Already connected: {target_lead.name or target_url}',
        )
    elif result['status'] == 'pending':
        await _mark_deal(target_deal.id, state='pending')
        await _mark_lead(target_lead.id, state='pending')
        await _log(
            task.user_id, task.campaign_id, 'info',
            f'Already pending: {target_lead.name or target_url}',
        )
    elif result['status'] == 'limit_reached':
        await _log(
            task.user_id, task.campaign_id, 'warning',
            'Weekly invite limit reached — pausing connects for this account',
        )
        # Не флипаем deal'у state — попробуем завтра
    else:  # no_button etc.
        await _mark_deal(target_deal.id, state='failed', outcome='wrong_fit',
                         qualification_reason=result.get('detail', 'connect failed'))
        await _mark_lead(target_lead.id, state='failed')
        await _log(
            task.user_id, task.campaign_id, 'warning',
            f'Connect failed ({result["status"]}): {target_lead.name or target_url} — {result.get("detail")}',
        )


# ─────────────── handle_check_pending ───────────────


@sync_to_async
def _pending_deals(user_id: uuid.UUID, campaign_id: uuid.UUID) -> list[tuple[Deal, Lead]]:
    deals = list(Deal.objects.filter(
        user_id=user_id, campaign_id=campaign_id, state='pending',
    ).order_by('updated_at')[:50])
    lead_ids = {d.lead_id for d in deals}
    leads_by_id = {l.id: l for l in Lead.objects.filter(id__in=lead_ids)}
    return [(d, leads_by_id[d.lead_id]) for d in deals if d.lead_id in leads_by_id]


async def handle_check_pending(task: Task, campaign: Campaign, ctx: BrowserContext) -> None:
    """
    Открывает sent-invitations page, scrape'ит pending. Кто пропал из этого
    списка → теперь connected.
    """
    await _ensure_logged_in(ctx, task.user_id)

    still_pending_ids = set(await li_actions.list_my_sent_invitations(ctx))

    pending = await _pending_deals(task.user_id, task.campaign_id)
    if not pending:
        await _log(task.user_id, task.campaign_id, 'info', 'No pending deals to check')
        return

    accepted_count = 0
    still_pending_count = 0
    for deal, lead in pending:
        pid = lead.public_identifier
        if not pid:
            continue
        if pid in still_pending_ids:
            still_pending_count += 1
            await _mark_deal(
                deal.id,
                next_check_pending_at=datetime.now(timezone.utc) + timedelta(days=1),
            )
        else:
            # Не в pending → значит accepted (или revoked, но мы не различаем)
            await _mark_deal(deal.id, state='connected', next_check_pending_at=None)
            await _mark_lead(lead.id, state='connected')
            accepted_count += 1
            await _log(
                task.user_id, task.campaign_id, 'info',
                f'Connection accepted: {lead.name or pid}',
                lead_id=str(lead.id),
            )

    await _log(
        task.user_id, task.campaign_id, 'info',
        f'Pending check done: {accepted_count} accepted, {still_pending_count} still pending',
    )


# ─────────────── handle_follow_up ───────────────


# После стольких НАШИХ сообщений лиду перестаём авто-писать — диалог уходит
# оператору (страховка от бесконечной переписки/спама).
MAX_AUTO_MESSAGES_PER_LEAD = 5


@sync_to_async
def _pick_connected_deal(user_id: uuid.UUID, campaign_id: uuid.UUID) -> tuple[Deal, Lead] | None:
    """
    Round-robin: самый давно не трогавшийся connected-Deal (по updated_at).
    Один follow_up task обрабатывает один диалог — читает тред и решает, слать ли.
    """
    deal = (
        Deal.objects
        .filter(user_id=user_id, campaign_id=campaign_id, state='connected')
        .order_by('updated_at')
        .first()
    )
    if not deal:
        return None
    lead = Lead.objects.filter(id=deal.lead_id).first()
    if not lead:
        return None
    return deal, lead


@sync_to_async
def _record_inbound(user_id, campaign_id, lead_id, content, external_id) -> bool:
    """Записываем входящее с дедупом по external_id (partial-unique). True — новая строка."""
    _, created = ChatMessage.objects.get_or_create(
        external_id=external_id,
        defaults={
            'user_id': user_id, 'campaign_id': campaign_id, 'lead_id': lead_id,
            'direction': 'inbound', 'content': content,
        },
    )
    close_old_connections()
    return created


@sync_to_async
def _our_outbound_count(user_id, lead_id) -> int:
    return ChatMessage.objects.filter(
        user_id=user_id, lead_id=lead_id, direction='outbound',
    ).count()


def _format_recent_messages(thread: list[dict], limit: int = 12) -> str:
    """Pure: тред → строки 'Me:'/'Lead:' (последние limit) для контекста LLM."""
    tag = {'inbound': 'Lead', 'outbound': 'Me', 'unknown': '?'}
    return '\n'.join(
        f"{tag.get(m.get('direction'), '?')}: {m.get('text', '')}"
        for m in thread[-limit:]
    )


def _inbound_external_id(lead_id: uuid.UUID, urn: str | None, text: str) -> str:
    """urn сообщения LinkedIn если есть, иначе стабильный (НЕ hash()) id по тексту."""
    if urn:
        return urn
    digest = hashlib.sha1(text.encode('utf-8')).hexdigest()[:16]
    return f'{lead_id}:in:{digest}'


@sync_to_async
def _record_message(user_id, campaign_id, lead_id, direction, content) -> None:
    ChatMessage.objects.create(
        user_id=user_id, campaign_id=campaign_id, lead_id=lead_id,
        direction=direction, content=content,
    )
    close_old_connections()


# Фолбэк-промпт демона (если в qualifiers нет follow_up_prompt — обычно его
# кладёт Portal /start). Jinja2 {{ }}, совпадает с Portal-дефолтом
# (v2DefaultPrompts.ts). Генерит ПЛОСКИЙ DM — opener (если переписки нет) или
# контекстный ответ на последнюю реплику лида (демон шлёт вывод LLM как есть,
# без парсинга action-протокола).
_FOLLOWUP_SYSTEM_PROMPT = '''Ты ведёшь переписку в LinkedIn с контактом, который принял запрос на связь.

## Наш продукт / услуга
{{ product_docs }}

## Цель кампании
{{ campaign_objective }}

## Кого мы ищем
{{ target_market }}

## Контакт
Имя: {{ lead_name }}
Должность: {{ lead_position }}
Компания: {{ lead_company }}

## Переписка (последние сообщения; «Me» — это ты, «Lead» — контакт)
{{ recent_messages }}

Как писать (метод «Mom Test»):
- Если переписки ещё нет — короткий тёплый первый месседж: не продавай, задай один вопрос о том, как человек сейчас решает задачу из нашей области.
- Если есть входящее от контакта — ответь контекстно на его последнюю реплику, в его тоне и на его языке.
- 1–3 коротких предложения. Без «Здравствуйте, надеюсь, у вас всё хорошо». Не используй имя в обращении и не подписывайся. Без жёсткого питча и плейсхолдеров [Имя].
- Если контакт явно отказался или не заинтересован — вежливо поблагодари и заверши, не дави.
- Определи язык по контакту; если не уверен — пиши по-русски.

Ответь ТОЛЬКО текстом сообщения — без кавычек, без преамбулы, без подписи.'''


async def handle_follow_up(task: Task, campaign: Campaign, ctx: BrowserContext) -> None:
    """
    Conversation loop по ОДНОМУ connected-диалогу (round-robin по updated_at):

    1. читаем тред → записываем новые входящие (дедуп по external_id)
    2. решаем: opener (переписки нет) / контекстный ответ (последняя реплика —
       от лида) / ждём (последнее слово за нами)
    3. cap MAX_AUTO_MESSAGES_PER_LEAD — дальше диалог уходит оператору

    deal.updated_at бампается в любом исходе, чтобы round-robin двигался дальше.
    """
    await _ensure_logged_in(ctx, task.user_id)

    pair = await _pick_connected_deal(task.user_id, task.campaign_id)
    if pair is None:
        await _log(task.user_id, task.campaign_id, 'info', 'No connected deals to process')
        return
    deal, lead = pair

    if not lead.profile_url:
        await _mark_deal(deal.id)  # bump updated_at — round-robin двигается дальше
        await _log(task.user_id, task.campaign_id, 'warning',
                   f'Lead {lead.name} has no profile_url, skip')
        return

    # 1. Читаем тред — пишем новые входящие.
    thread = await li_actions.read_thread(ctx, lead.profile_url, lead.public_identifier)
    new_inbound = 0
    for m in thread:
        if m['direction'] != 'inbound':
            continue
        ext = _inbound_external_id(deal.lead_id, m['external_id'], m['text'])
        if await _record_inbound(task.user_id, task.campaign_id, deal.lead_id, m['text'], ext):
            new_inbound += 1
    if new_inbound:
        await _mark_lead(lead.id, last_activity_at=datetime.now(timezone.utc))
        await _log(task.user_id, task.campaign_id, 'info',
                   f'{new_inbound} новых ответ(ов) от {lead.name or lead.public_identifier}',
                   lead_id=str(lead.id))

    # 2. Cap авто-сообщений — дальше оператор ведёт сам.
    our_count = await _our_outbound_count(task.user_id, deal.lead_id)
    if our_count >= MAX_AUTO_MESSAGES_PER_LEAD:
        await _mark_deal(deal.id)
        await _log(task.user_id, task.campaign_id, 'info',
                   f'Лимит авто-сообщений достигнут для {lead.name or lead.public_identifier} — оставляю оператору',
                   lead_id=str(lead.id))
        return

    # 3. Решаем намерение.
    last = thread[-1] if thread else None
    if not thread:
        intent = 'opener'
    elif last and last['direction'] == 'inbound':
        intent = 'reply'
    else:
        intent = 'wait'  # последнее слово за нами — ждём ответа лида

    if intent == 'wait':
        await _mark_deal(deal.id)
        return

    # 4. Генерим сообщение с контекстом треда.
    qual = await _campaign_qualifiers(task.campaign_id)
    template = (qual.get('follow_up_prompt') or _FOLLOWUP_SYSTEM_PROMPT).strip()
    profile_summary = ', '.join(p for p in (lead.name, lead.position, lead.company) if p) or 'unknown'
    recent = _format_recent_messages(thread)

    system = render_prompt(
        template,
        product_docs=qual.get('product_description', ''),
        product_description=qual.get('product_description', ''),  # alias для старых шаблонов
        campaign_objective=qual.get('campaign_objective', ''),
        target_market=qual.get('target_market', ''),
        lead_name=lead.name or lead.first_name or '',
        lead_position=lead.position or '',
        lead_company=lead.company or '',
        recent_messages=recent,
        # Передаём и редкие переменные старых/кастомных шаблонов, чтобы {{ }} не утёк.
        self_name=qual.get('self_name', ''),
        profile_summary=profile_summary,
        chat_summary='',
        contact_email='',
        today=datetime.now(timezone.utc).date().isoformat(),
        days_since_last_outgoing=None,
        unanswered_outgoing=None,
    )
    user_msg = (
        'Напиши первое сообщение контакту.' if intent == 'opener'
        else 'Ответь на последнюю реплику контакта.'
    )

    try:
        message = await llm_complete(system=system, user=user_msg, max_tokens=400, temperature=0.7)
    except LLMError as e:
        await _mark_deal(deal.id)
        await _log(task.user_id, task.campaign_id, 'error', f'LLM failed: {e}')
        return

    ok = await li_actions.send_message(ctx, lead.profile_url, message)
    if ok:
        await _record_message(task.user_id, task.campaign_id, deal.lead_id, 'outbound', message)
        await _mark_deal(deal.id, updated_at=datetime.now(timezone.utc))
        await _log(
            task.user_id, task.campaign_id, 'info',
            f'{"Opener" if intent == "opener" else "Ответ"} отправлен: {lead.name or lead.public_identifier}',
            lead_id=str(lead.id), message_preview=message[:120],
        )
    else:
        await _mark_deal(deal.id)
        await _log(task.user_id, task.campaign_id, 'warning',
                   f'Не удалось отправить сообщение: {lead.name or lead.public_identifier}')
