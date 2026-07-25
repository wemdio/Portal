/**
 * Backend logic for the /client/dashboard onboarding checklist.
 *
 * Pure-ish function: takes a userId + two supabase clients (public schema +
 * instantly schema) and returns the 7-item progress structure that matches
 * Phase 0 of the May 2026 UX redesign.
 *
 * Keeping this OUTSIDE the route handler so it's testable without involving
 * Next.js request lifecycle or the cache wrapper. The route file imports this
 * and wraps the call in `cached()` for a short TTL.
 *
 * Performance: 8 small queries to the database in parallel (most return 0-1
 * rows). On a warm connection this is < 50ms total, well below the 15s cache
 * TTL we set in the route handler.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { SETUP_DAYS } from '@/lib/tariffs';

export type OnboardingStepId =
  | 'brief'
  | 'domains'
  | 'preset'
  | 'first_base'
  | 'first_clean'
  | 'first_sequence'
  | 'first_launch';

export interface OnboardingStatusItem {
  id: OnboardingStepId;
  label: string;
  done: boolean;
  /** Where to take the user when they tap this row. null = handled by manager (no client action). */
  href: string | null;
  /** Human-readable explanation when done=false and the user can't unblock it themselves. */
  blocked_reason?: string;
}

export interface OnboardingStatusResponse {
  items: OnboardingStatusItem[];
  /** True iff every item is done. */
  complete: boolean;
  /** Id of the first not-done item the user should tackle next, or null when complete. */
  next_id: OnboardingStepId | null;
  /**
   * Estimated mailbox-readiness date for the preset-step countdown, or null
   * when the preset is already configured (nothing to count down to) or when
   * neither the setup window nor a confirmed domain selection is known.
   */
  mail_ready_at: string | null;
}

export interface OnboardingStatusDeps {
  /** Supabase client for the `public` schema (auth, base_constructor_jobs, profiles). */
  supabaseAdmin: SupabaseClient;
  /** Supabase client for the `instantly` schema (briefs, presets, launches). */
  supabaseInstantly: SupabaseClient;
}

const STEP_ORDER: readonly OnboardingStepId[] = [
  'brief',
  'domains',
  'preset',
  'first_base',
  'first_clean',
  'first_sequence',
  'first_launch',
] as const;

const LAUNCH_DONE_STATUSES: readonly string[] = ['active', 'paused', 'completed'];

interface BriefFieldsShape {
  company_description?: unknown;
  product_description?: unknown;
  target_audience?: unknown;
}

/**
 * The brief is considered "started enough" when at least one of the three
 * core fields (company description, product description, target audience)
 * has any non-whitespace content. This keeps the checklist responsive — a
 * client who fills any one field on first save is rewarded immediately.
 */
function hasMinimalBriefContent(fields: BriefFieldsShape | null | undefined): boolean {
  if (!fields || typeof fields !== 'object') return false;
  const fieldsToCheck: (keyof BriefFieldsShape)[] = [
    'company_description',
    'product_description',
    'target_audience',
  ];
  for (const key of fieldsToCheck) {
    const value = fields[key];
    if (typeof value === 'string' && value.trim().length > 0) return true;
  }
  return false;
}

export async function computeOnboardingStatus(
  userId: string,
  deps: OnboardingStatusDeps,
): Promise<OnboardingStatusResponse> {
  const { supabaseAdmin, supabaseInstantly } = deps;

  // All eight queries run in parallel — none depend on each other's output.
  const [briefRes, domainsRes, presetRes, jobsRes, launchesRes, sequencesRes, sequencesV2Res, tariffRes] = await Promise.all([
    supabaseInstantly
      .from('client_briefs')
      .select('fields')
      .eq('client_user_id', userId)
      .maybeSingle(),
    supabaseInstantly
      .from('client_domain_selections')
      .select('selected, required_count, status, updated_at')
      .eq('client_user_id', userId)
      .maybeSingle(),
    supabaseInstantly
      .from('client_campaign_presets')
      .select('email_account_ids')
      .eq('client_user_id', userId)
      .maybeSingle(),
    supabaseAdmin
      .from('base_constructor_jobs')
      .select('status')
      .eq('user_id', userId),
    supabaseInstantly
      .from('client_campaign_launches')
      .select('status')
      .eq('client_user_id', userId),
    // email_sequence_runs живёт в public-схеме, ключ user_id = auth-юзер
    // (см. /api/tools/email-sequence/runs). Нужен только status.
    supabaseAdmin
      .from('email_sequence_runs')
      .select('status')
      .eq('user_id', userId),
    // v2-инструмент («Цепочки писем 2.0», /client/sequences) пишет в СВОЮ
    // таблицу. Клиентский allowlist пускает только v2-роуты, поэтому без
    // этого запроса шаг «первая цепочка» у реальных клиентов не завершался
    // бы никогда. Зеркалит tariffs.countChains (считает обе таблицы).
    supabaseAdmin
      .from('email_sequence_v2_runs')
      .select('status')
      .eq('user_id', userId),
    // setup-окно (15 дней с регистрации) — для таймера готовности почт.
    supabaseAdmin
      .from('client_tariffs')
      .select('setup_until')
      .eq('user_id', userId)
      .maybeSingle(),
  ]);

  // ── Brief ────────────────────────────────────────────────────────────
  const briefFields = (briefRes.data?.fields ?? null) as BriefFieldsShape | null;
  const briefDone = hasMinimalBriefContent(briefFields);

  // ── Preset ───────────────────────────────────────────────────────────
  const presetRow = presetRes.data as { email_account_ids?: unknown } | null;
  const presetEmailIds = Array.isArray(presetRow?.email_account_ids)
    ? (presetRow!.email_account_ids as unknown[])
    : [];
  const presetDone = presetEmailIds.length > 0;

  // ── Domains ──────────────────────────────────────────────────────────
  // Шаг закрыт, когда клиент подтвердил ПОЛНЫЙ набор: selected непустой и
  // по размеру равен required_count (3/6 в зависимости от тарифа).
  //
  // ВАЖНО: клиенты, онбордженные ДО появления этого шага (у них уже есть
  // пресет с email_account_ids — менеджер купил домены вручную), шаг
  // засчитываем автоматически. Иначе у всех существующих клиентов чеклист
  // «ожил» бы с требованием выбрать новые домены.
  const domainsRow = domainsRes.data as {
    selected?: unknown;
    required_count?: unknown;
    status?: unknown;
    updated_at?: unknown;
  } | null;
  const domainsSelected = Array.isArray(domainsRow?.selected)
    ? (domainsRow!.selected as unknown[]).filter((d) => typeof d === 'string' && d.trim())
    : [];
  const domainsRequired = Number(domainsRow?.required_count) || 0;
  const domainsDone =
    presetDone || (domainsRequired > 0 && domainsSelected.length === domainsRequired);

  // ── Таймер готовности почт (для UI шага preset) ──────────────────────
  // Запуск кампаний закрыт двумя вещами: системным setup-окном (SETUP_DAYS
  // с регистрации, client_tariffs.setup_until) и фактическим прогревом почт,
  // который менеджер начинает после подтверждения доменов клиентом. Берём
  // max() из известных дат — «точно готово не раньше». null, когда пресет
  // уже настроен (считать нечего) или неизвестны обе даты.
  let mailReadyAt: string | null = null;
  if (!presetDone) {
    const candidates: number[] = [];
    const setupUntilRaw = (tariffRes.data as { setup_until?: unknown } | null)?.setup_until;
    const setupUntilMs = typeof setupUntilRaw === 'string' ? Date.parse(setupUntilRaw) : NaN;
    if (Number.isFinite(setupUntilMs)) candidates.push(setupUntilMs);
    const selectedAtMs =
      domainsRow?.status === 'selected' && typeof domainsRow.updated_at === 'string'
        ? Date.parse(domainsRow.updated_at)
        : NaN;
    if (Number.isFinite(selectedAtMs)) {
      candidates.push(selectedAtMs + SETUP_DAYS * 24 * 60 * 60 * 1000);
    }
    if (candidates.length > 0) mailReadyAt = new Date(Math.max(...candidates)).toISOString();
  }

  // ── first_base / first_clean (from base_constructor_jobs) ────────────
  const jobs = (jobsRes.data ?? []) as { status?: unknown }[];
  const hasAnyJob = jobs.length > 0;
  const hasCompletedJob = jobs.some((j) => j.status === 'completed');

  // ── first_base / first_launch (from client_campaign_launches) ────────
  const launches = (launchesRes.data ?? []) as { status?: unknown }[];
  const hasAnyLaunch = launches.length > 0;
  const hasLaunchedCampaign = launches.some(
    (l) => typeof l.status === 'string' && LAUNCH_DONE_STATUSES.includes(l.status),
  );

  // ── first_sequence (from email_sequence_runs) ────────────────────────
  // ВАЖНО: пустой run создаётся со status='draft' уже при первом POST в
  // инструмент (/api/tools/email-sequence/runs). Засчитывать draft нельзя
  // — иначе шаг «пройден» только от того, что клиент открыл вкладку.
  // Считаем выполненным, когда есть run со status='completed' (его ставят
  // generate-segments и generate-chain). Симметрично с first_clean.
  const sequences = (sequencesRes.data ?? []) as { status?: unknown }[];
  const sequencesV2 = (sequencesV2Res.data ?? []) as { status?: unknown }[];
  const firstSequenceDone =
    sequences.some((s) => s.status === 'completed') ||
    sequencesV2.some((s) => s.status === 'completed');

  const firstBaseDone = hasAnyJob || hasAnyLaunch;
  const firstCleanDone = hasCompletedJob;
  const firstLaunchDone = hasLaunchedCampaign;

  // ── Build response ───────────────────────────────────────────────────
  const items: OnboardingStatusItem[] = [
    {
      id: 'brief',
      label: 'Заполнить бриф',
      done: briefDone,
      href: '/client/brief',
    },
    {
      // Действие инлайн: чеклист раскрывает DomainSelector прямо в карточке
      // шага, поэтому href=null и без blocked_reason.
      id: 'domains',
      label: 'Выбрать домены для рассылки',
      done: domainsDone,
      href: null,
    },
    presetDone
      ? {
          id: 'preset',
          label: 'Менеджер настроил пресет',
          done: true,
          href: null,
        }
      : {
          id: 'preset',
          label: 'Менеджер настроил пресет',
          done: false,
          href: null,
          blocked_reason: presetRow
            ? 'Пресет создан, менеджер подключает к нему email-аккаунты.'
            : 'Менеджер создаёт и прогревает почтовые ящики для ваших кампаний.',
        },
    {
      id: 'first_base',
      label: 'Собрать первую базу',
      done: firstBaseDone,
      href: '/client/build',
    },
    {
      id: 'first_clean',
      label: 'Очистить первую базу',
      done: firstCleanDone,
      href: '/client/base-constructor',
    },
    {
      id: 'first_sequence',
      label: 'Написать первую цепочку писем',
      done: firstSequenceDone,
      href: '/client/sequences',
    },
    {
      id: 'first_launch',
      label: 'Запустить первую кампанию',
      done: firstLaunchDone,
      href: '/client/launch',
    },
  ];

  const complete = items.every((i) => i.done);
  const nextItem = items.find((i) => !i.done) ?? null;
  const next_id = (nextItem?.id ?? null) as OnboardingStepId | null;

  // Cheap sanity check: items are returned in the canonical step order.
  // (kept for assertion in tests; cheap at runtime.)
  if (process.env.NODE_ENV !== 'production') {
    const ids = items.map((i) => i.id);
    for (let i = 0; i < STEP_ORDER.length; i++) {
      if (ids[i] !== STEP_ORDER[i]) {
        throw new Error(`onboardingStatus: step order broken at index ${i}`);
      }
    }
  }

  return { items, complete, next_id, mail_ready_at: mailReadyAt };
}
