"""
Portal-native Django models, targeted at `li2_*` tables in Portal Supabase.

Эти модели — наш fork-specific surface. Owners схемы — Portal-овская миграция
supabase/migrations/20260610_0001 (Django Meta.managed=False). Если хочется
добавить колонку: сначала миграция в Portal'е, потом сюда.

Daemon (`linkedin.daemon.main_loop`) и его подсистемы — единственные
консьюмеры этих моделей. Upstream Campaign/Lead/Deal/Task оставлены для
upstream CLI-команд (если их кто-то использует) и reference; в проде они
не дёргаются.
"""
from __future__ import annotations

import logging
import uuid

from django.contrib.postgres.fields import ArrayField
from django.db import models
from django.utils import timezone

logger = logging.getLogger(__name__)


# ──────────────────────── Account ────────────────────────


class Account(models.Model):
    """
    Per-Portal-user LinkedIn account state. Daemon в main loop поллит эту
    таблицу на status='running' и dispatch'ит AccountWorker'ов.

    Жизненный цикл status:
    - stopped       — юзер не активировал, daemon Worker'а не держит
    - running       — daemon крутит, AccountWorker активен
    - needs_captcha — daemon уперся в /checkpoint/, ждёт VNC-разруливания
    - disconnected  — LinkedIn auth-failure, нужно вмешательство юзера
    """
    STATUS_CHOICES = [
        ('stopped', 'Stopped'),
        ('running', 'Running'),
        ('needs_captcha', 'Needs CAPTCHA'),
        ('disconnected', 'Disconnected'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    user_id = models.UUIDField(db_index=True)
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default='stopped')
    runtime_status = models.CharField(max_length=32, default='idle')
    last_heartbeat_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(default=timezone.now)

    class Meta:
        managed = False
        db_table = 'li2_accounts'

    def __str__(self):
        return f'Account(user={self.user_id}, status={self.status})'


# ──────────────────────── PortalSettings ────────────────────────


class PortalSettings(models.Model):
    """
    Per-user prefs, set'ятся через Portal UI (`li2_settings`). Daemon только
    читает: LinkedIn creds, prompts, proxy, limits.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    user_id = models.UUIDField(db_index=True)
    linkedin_email = models.TextField(default='')
    linkedin_password = models.TextField(default='')
    proxy_url = models.TextField(default='')
    connect_daily_limit = models.IntegerField(default=20)
    connect_weekly_limit = models.IntegerField(default=100)
    follow_up_daily_limit = models.IntegerField(default=25)
    legal_accepted = models.BooleanField(default=False)
    prompt_follow_up_agent = models.TextField(default='')
    prompt_qualify_lead = models.TextField(default='')
    prompt_search_keywords = models.TextField(default='')
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(default=timezone.now)

    class Meta:
        managed = False
        db_table = 'li2_settings'


# ──────────────────────── Campaign ────────────────────────


class Campaign(models.Model):
    """
    Кампания — единица настроек outreach'a. UI хранит config (продукт, рынок,
    цель), daemon читает + крутит state machine.

    `qualifiers jsonb` содержит per-campaign LLM-конфиг: список
    {name, prompt, product_description, target_market, campaign_objective,
     follow_up_prompt, search_keywords_prompt, seed_profile_urls}. Записывается
    Portal API ручкой /start (см. start/route.ts).
    """
    STATUS_CHOICES = [
        ('draft', 'Draft'),
        ('queued', 'Queued'),
        ('running', 'Running'),
        ('paused', 'Paused'),
        ('stopped', 'Stopped'),
        ('completed', 'Completed'),
        ('error', 'Error'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    user_id = models.UUIDField(db_index=True)
    name = models.TextField()
    product_description = models.TextField(default='')
    target_market = models.TextField(default='')
    campaign_objective = models.TextField(default='')
    seed_profile_urls = models.TextField(default='')
    # БД-колонка — Postgres text[] (миграция 20260608_0001), НЕ jsonb. psycopg
    # отдаёт её как list[str]; ArrayField матчит это напрямую. JSONField здесь
    # ронял чтение любой кампании (json.loads на python-list → TypeError).
    working_hours = ArrayField(models.TextField(), default=list)  # ['09:00-18:00', ...]
    timezone_offset = models.IntegerField(default=0)
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default='draft')
    runtime_status = models.TextField(default='not_started')
    runtime_instance_id = models.TextField(null=True, blank=True)
    stats = models.JSONField(default=dict)
    qualifiers = models.JSONField(default=list)
    model_blob = models.BinaryField(null=True, blank=True)
    last_sync_at = models.DateTimeField(null=True, blank=True)
    error_message = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(default=timezone.now)

    class Meta:
        managed = False
        db_table = 'li2_campaigns'

    def __str__(self):
        return f'Campaign({self.name})'


# ──────────────────────── Lead ────────────────────────


class Lead(models.Model):
    """Lead — конкретный человек на LinkedIn. Per-(user, profile_url) сущность."""
    STATE_CHOICES = [
        ('discovered', 'Discovered'),
        ('qualified', 'Qualified'),
        ('ready_to_connect', 'Ready to Connect'),
        ('pending', 'Pending'),
        ('connected', 'Connected'),
        ('completed', 'Completed'),
        ('failed', 'Failed'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    user_id = models.UUIDField(db_index=True)
    campaign_id = models.UUIDField(null=True, blank=True, db_index=True)
    public_identifier = models.TextField(null=True, blank=True)
    profile_url = models.TextField(null=True, blank=True)
    name = models.TextField(default='')
    first_name = models.TextField(null=True, blank=True)
    last_name = models.TextField(null=True, blank=True)
    position = models.TextField(null=True, blank=True)
    company = models.TextField(null=True, blank=True)
    state = models.CharField(max_length=20, choices=STATE_CHOICES, default='discovered')
    qualification_score = models.FloatField(null=True, blank=True)
    qualification_reason = models.TextField(null=True, blank=True)
    outcome = models.TextField(null=True, blank=True)
    chat_summary = models.JSONField(default=list)
    extra_data = models.JSONField(default=dict)
    urn = models.TextField(null=True, blank=True)
    embedding = models.BinaryField(null=True, blank=True)
    disqualified = models.BooleanField(default=False)
    meta = models.JSONField(default=dict)
    last_activity_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(default=timezone.now)

    class Meta:
        managed = False
        db_table = 'li2_leads'

    def __str__(self):
        return f'Lead({self.name or self.public_identifier})'


# ──────────────────────── Deal ────────────────────────


class Deal(models.Model):
    """
    Per-(campaign × lead) state machine row. Один lead может участвовать в
    нескольких кампаниях — каждая своя deal-строка.
    """
    STATE_CHOICES = [
        ('qualified', 'Qualified'),
        ('ready_to_connect', 'Ready to Connect'),
        ('pending', 'Pending'),
        ('connected', 'Connected'),
        ('completed', 'Completed'),
        ('failed', 'Failed'),
    ]
    OUTCOME_CHOICES = [
        ('converted', 'Converted'),
        ('not_interested', 'Not Interested'),
        ('wrong_fit', 'Wrong Fit'),
        ('no_budget', 'No Budget'),
        ('has_solution', 'Has Solution'),
        ('bad_timing', 'Bad Timing'),
        ('unresponsive', 'Unresponsive'),
        ('unknown', 'Unknown'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    user_id = models.UUIDField(db_index=True)
    campaign_id = models.UUIDField(db_index=True)
    lead_id = models.UUIDField(db_index=True)
    state = models.CharField(max_length=20, choices=STATE_CHOICES, default='qualified')
    outcome = models.CharField(max_length=20, choices=OUTCOME_CHOICES, null=True, blank=True)
    qualification_score = models.FloatField(null=True, blank=True)
    qualification_reason = models.TextField(null=True, blank=True)
    profile_summary = models.JSONField(default=list)
    chat_summary = models.JSONField(default=list)
    next_check_pending_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(default=timezone.now)

    class Meta:
        managed = False
        db_table = 'li2_deals'
        unique_together = [('campaign_id', 'lead_id')]


# ──────────────────────── Task ────────────────────────


class Task(models.Model):
    """
    Planner-queue: Poisson-распределённые task slots внутри 24h окна.

    daemon AccountWorker SELECT'ит pending+due tasks по (account_id), берёт
    одну, mark'ает running, выполняет handler, mark'ает completed/failed.
    """
    TYPE_CHOICES = [
        ('connect', 'Connect'),
        ('check_pending', 'Check Pending'),
        ('follow_up', 'Follow Up'),
    ]
    STATUS_CHOICES = [
        ('pending', 'Pending'),
        ('running', 'Running'),
        ('completed', 'Completed'),
        ('failed', 'Failed'),
        ('cancelled', 'Cancelled'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    user_id = models.UUIDField(db_index=True)
    account_id = models.UUIDField(db_index=True)
    campaign_id = models.UUIDField(db_index=True)
    type = models.CharField(max_length=20, choices=TYPE_CHOICES)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='pending')
    scheduled_at = models.DateTimeField()
    payload = models.JSONField(default=dict)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    error_message = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        managed = False
        db_table = 'li2_tasks'


# ──────────────────────── ChatMessage ────────────────────────


class ChatMessage(models.Model):
    """Сообщение из/в LinkedIn-чат с лидом. Append-only."""
    DIRECTION_CHOICES = [
        ('inbound', 'Inbound'),
        ('outbound', 'Outbound'),
        ('system', 'System'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    user_id = models.UUIDField(db_index=True)
    campaign_id = models.UUIDField(null=True, blank=True, db_index=True)
    lead_id = models.UUIDField(null=True, blank=True, db_index=True)
    direction = models.CharField(max_length=10, choices=DIRECTION_CHOICES)
    content = models.TextField(default='')
    provider_id = models.TextField(null=True, blank=True)
    external_id = models.TextField(null=True, blank=True)
    sent_at = models.DateTimeField(default=timezone.now)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        managed = False
        db_table = 'li2_messages'


# ──────────────────────── BrowserSession ────────────────────────


class BrowserSession(models.Model):
    """Playwright storage_state (cookies + storage) per LinkedIn-аккаунт."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    user_id = models.UUIDField(db_index=True)
    account_id = models.UUIDField(unique=True, db_index=True)
    storage_state = models.JSONField(null=True, blank=True)
    cookies = models.BinaryField(default=b'')
    updated_at = models.DateTimeField(default=timezone.now)

    class Meta:
        managed = False
        db_table = 'li2_browser_sessions'


# ──────────────────────── PortalLog ────────────────────────


class PortalLog(models.Model):
    """
    Лог-журнал для UI. Daemon пишет события (`sent invite`, `qualified lead`,
    etc.), Portal UI читает через GET /tools/li-outreach-v2/logs.
    """
    LEVEL_CHOICES = [
        ('info', 'Info'),
        ('warning', 'Warning'),
        ('error', 'Error'),
    ]

    id = models.BigAutoField(primary_key=True)
    user_id = models.UUIDField(null=True, blank=True, db_index=True)
    campaign_id = models.UUIDField(null=True, blank=True, db_index=True)
    lead_id = models.UUIDField(null=True, blank=True)
    level = models.CharField(max_length=10, choices=LEVEL_CHOICES, default='info')
    message = models.TextField()
    details = models.JSONField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        managed = False
        db_table = 'li2_logs'

    @classmethod
    def info(cls, *, user_id=None, campaign_id=None, message: str, details=None):
        cls.objects.create(
            user_id=user_id, campaign_id=campaign_id,
            level='info', message=message, details=details,
        )

    @classmethod
    def warning(cls, *, user_id=None, campaign_id=None, message: str, details=None):
        cls.objects.create(
            user_id=user_id, campaign_id=campaign_id,
            level='warning', message=message, details=details,
        )

    @classmethod
    def error(cls, *, user_id=None, campaign_id=None, message: str, details=None):
        cls.objects.create(
            user_id=user_id, campaign_id=campaign_id,
            level='error', message=message, details=details,
        )
