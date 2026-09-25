/**
 * Срок доставки контактов для проекта Portal без периодов.
 *
 * У многих проектов Portal нет ни одной строки project_periods: договором
 * служит сама карточка проекта (статус и дедлайн). Такой проект запускается
 * без периода: цель вводит специалист, темп считается до projects.deadline,
 * факт плана — первые контакты кампаний этого VE2-проекта. Накопленный
 * projects.contacts_done и текст обязательства только показываются.
 *
 * Список рабочих статусов повторён в SQL ve_contact_delivery_term
 * (supabase/migrations/20260924_0010_ve_contact_delivery_without_period.sql);
 * их совпадение проверяет тест миграции. Разбор «Дедлайна» повторён в SQL
 * ve_try_iso_date (20260924_0011); общие случаи — tests/helpers/projectDeadlineCases.json.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  checkCampaignProjectOwnershipConflicts,
  claimCampaignProjectOwnership,
  type CampaignProjectOwnershipConflict,
} from '@/lib/instantly/campaignProjectOwnership';

export const LAUNCHABLE_PORTAL_PROJECT_STATUSES = ['В работе', 'Тестирование', 'Подготовка', 'На паузе'] as const;

/** Колонки projects, нужные для срока без периода. */
export const PORTAL_PROJECT_TERM_COLUMNS =
  'id, client, name, status, deadline, launch_date, contacts_obligation, contacts_done';

export interface PortalProjectTermRow {
  id: string;
  client?: string | null;
  name?: string | null;
  status?: string | null;
  deadline?: string | null;
  launch_date?: string | null;
  contacts_obligation?: string | null;
  contacts_done?: string | number | null;
}

export interface PortalPeriodStateRow {
  id: string;
  status?: string | null;
}

export type PortalProjectTermIssueCode =
  | 'PORTAL_PROJECT_HAS_ACTIVE_PERIOD'
  | 'PORTAL_PERIODS_CLOSED'
  | 'PORTAL_PERIOD_CREATED_AFTER_LAUNCH'
  | 'PORTAL_PROJECT_NOT_IN_WORK'
  | 'PROJECT_DEADLINE_REQUIRED'
  | 'PROJECT_DEADLINE_INVALID'
  | 'PROJECT_DEADLINE_PASSED'
  | 'PORTAL_PROJECT_MANUAL_FACT';

export interface PortalProjectTermIssue {
  ok: false;
  code: PortalProjectTermIssueCode;
  error: string;
}

export interface PortalProjectTermOk {
  ok: true;
  /** Дедлайн из карточки проекта, YYYY-MM-DD. */
  deadline: string;
  startsAt: string | null;
  /** Свободный текст обязательства из карточки («4000», «8000-16000», пусто). Не разбирается. */
  obligationText: string | null;
  /** Накопленный projects.contacts_done. В расчёт плана не входит. */
  factTotal: number | null;
}

export type PortalProjectTerm = PortalProjectTermOk | PortalProjectTermIssue;

export const PORTAL_TERM_TEXT = {
  periodsClosed: 'Все периоды проекта закрыты. Откройте новый период в карточке проекта.',
  // Виден, только если список проектов на странице устарел: период создали, пока форма была открыта.
  hasActivePeriod: 'У проекта уже есть активный период. Обновите страницу — запуск привяжется к периоду.',
  periodCreatedAfterLaunch:
    'Проекту в Portal создан период. Загрузка новых контактов по этому плану остановлена: план рассчитан на проект без периодов. Уже загруженные контакты продолжают отправляться.',
  notInWork: (status: string) =>
    `Проект в Portal не в работе (статус «${status || 'не указан'}»). Верните рабочий статус в карточке проекта.`,
  deadlineRequired:
    'В карточке проекта не заполнено поле «Дедлайн». Укажите дату в формате ГГГГ-ММ-ДД — темп рассчитается до неё.',
  deadlineInvalid: (raw: string) =>
    `В карточке проекта в поле «Дедлайн» указана не дата («${raw}»). Укажите дату в формате ГГГГ-ММ-ДД — темп рассчитается до неё.`,
  deadlinePassed: (deadline: string) =>
    `Дедлайн проекта (${formatRuDate(deadline)}) уже прошёл. Обновите поле «Дедлайн» в карточке проекта.`,
  /**
   * Дописывается к причине паузы уже закреплённого плана, которую снимает
   * правка карточки (статус, пустой, не-ISO или прошедший «Дедлайн»). Если
   * за паузу все кампании плана завершились, пакет уходит из портфеля
   * («Все кампании завершены») и сам не вернётся — так же, как у закрытого
   * периода. SQL ve_contact_delivery_term считает все эти случаи одинаково.
   */
  boundResumeNote:
    'Загрузка продолжится сама, если к этому времени кампании плана ещё не завершились; иначе понадобится новый запуск.',
  manualFact: (fact: string) =>
    `Факт контактов проекта (${fact}) ведётся вручную: к проекту не привязана ни одна кампания Instantly. После запуска Portal начнёт считать факт по кампаниям, и ручное число пропадёт. Сначала привяжите кампании проекта в его карточке.`,
} as const;

function clean(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' ? value.trim() : '';
}

function exactCount(value: unknown): number | null {
  const normalized = clean(value);
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function isIsoCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1) return false;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** «Дедлайн» карточки как YYYY-MM-DD: ISO или ДД.ММ.ГГ(ГГ), как подсказывает редактор карточки. */
export function parseProjectDeadline(value: string): string | null {
  if (isIsoCalendarDate(value)) return value;
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(value);
  if (!match) return null;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  const iso = `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  return isIsoCalendarDate(iso) ? iso : null;
}

function formatRuDate(value: string): string {
  const [year, month, day] = value.split('-');
  return day && month && year ? `${day}.${month}.${year}` : value;
}

/** Календарная дата в часовом поясе отправки, YYYY-MM-DD. */
export function localIsoDate(now: Date, timezone: string): string {
  const parts = new Map(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
}

export function portalProjectTermIssue(code: PortalProjectTermIssueCode, error: string): PortalProjectTermIssue {
  return { ok: false, code, error };
}

/** Причина паузы закреплённого плана с оговоркой, когда поток не вернётся сам. */
export function withBoundResumeNote(error: string, bound: boolean | undefined): string {
  return bound ? `${error} ${PORTAL_TERM_TEXT.boundResumeNote}` : error;
}

/**
 * Можно ли вести доставку по проекту без периода. `bound` — план уже
 * закреплён без периода: появившийся период тогда означает смену режима.
 * `today` не передают, пока неизвестен часовой пояс отправки.
 */
export function describePortalProjectTerm(
  project: PortalProjectTermRow,
  periods: readonly PortalPeriodStateRow[],
  options: { today?: string | null; bound?: boolean } = {},
): PortalProjectTerm {
  if (periods.length > 0) {
    if (options.bound) {
      return portalProjectTermIssue('PORTAL_PERIOD_CREATED_AFTER_LAUNCH', PORTAL_TERM_TEXT.periodCreatedAfterLaunch);
    }
    return periods.some((period) => period.status === 'active')
      ? portalProjectTermIssue('PORTAL_PROJECT_HAS_ACTIVE_PERIOD', PORTAL_TERM_TEXT.hasActivePeriod)
      : portalProjectTermIssue('PORTAL_PERIODS_CLOSED', PORTAL_TERM_TEXT.periodsClosed);
  }
  const cardIssue = (code: PortalProjectTermIssueCode, error: string) =>
    portalProjectTermIssue(code, withBoundResumeNote(error, options.bound));
  const status = clean(project.status);
  if (!(LAUNCHABLE_PORTAL_PROJECT_STATUSES as readonly string[]).includes(status)) {
    return cardIssue('PORTAL_PROJECT_NOT_IN_WORK', PORTAL_TERM_TEXT.notInWork(status));
  }
  const rawDeadline = clean(project.deadline);
  if (!rawDeadline) return cardIssue('PROJECT_DEADLINE_REQUIRED', PORTAL_TERM_TEXT.deadlineRequired);
  const deadline = parseProjectDeadline(rawDeadline);
  if (!deadline) {
    return cardIssue('PROJECT_DEADLINE_INVALID', PORTAL_TERM_TEXT.deadlineInvalid(rawDeadline));
  }
  if (options.today && deadline < options.today) {
    return cardIssue('PROJECT_DEADLINE_PASSED', PORTAL_TERM_TEXT.deadlinePassed(deadline));
  }
  const startsAt = clean(project.launch_date);
  return {
    ok: true,
    deadline,
    startsAt: startsAt || null,
    obligationText: clean(project.contacts_obligation) || null,
    factTotal: exactCount(project.contacts_done),
  };
}

export async function loadPortalProjectTerm(
  portalDb: SupabaseClient,
  portalProjectId: string,
): Promise<{ project: PortalProjectTermRow | null; periods: PortalPeriodStateRow[] }> {
  const [projectRead, periodsRead] = await Promise.all([
    portalDb.from('projects').select(PORTAL_PROJECT_TERM_COLUMNS).eq('id', portalProjectId).maybeSingle(),
    portalDb.from('project_periods').select('id, status').eq('project_id', portalProjectId),
  ]);
  if (projectRead.error) throw new Error(`Portal project read failed: ${projectRead.error.message}`);
  if (periodsRead.error) throw new Error(`Portal project periods read failed: ${periodsRead.error.message}`);
  return {
    project: (projectRead.data as PortalProjectTermRow | null) ?? null,
    periods: (periodsRead.data ?? []) as PortalPeriodStateRow[],
  };
}

/** VE2-проекты, чей план закреплён за этим проектом Portal без периода. */
export async function loadNoPeriodPlanOwners(portalDb: SupabaseClient, portalProjectId: string): Promise<string[]> {
  const { data, error } = await portalDb
    .from('ve_projects')
    .select('id, portal_period_id')
    .eq('portal_project_id', portalProjectId);
  if (error) throw new Error(`VE2 project bindings read failed: ${error.message}`);
  return ((data ?? []) as Array<{ id: string; portal_period_id?: string | null }>)
    .filter((row) => !row.portal_period_id)
    .map((row) => row.id);
}

/**
 * Ночная синхронизация перезаписывает projects.contacts_done суммой по
 * связанным кампаниям. Если связок нет, а факт уже есть, его ведут руками:
 * первая же кампания VE2 затёрла бы это число. Такой запуск не начинаем.
 */
export async function findManualFactIssue(
  instantlyDb: SupabaseClient,
  project: Pick<PortalProjectTermRow, 'id' | 'contacts_done'>,
): Promise<PortalProjectTermIssue | null> {
  const fact = clean(project.contacts_done);
  if (!fact || exactCount(fact) === 0) return null;
  const { count, error } = await instantlyDb
    .from('project_instantly_campaigns')
    .select('campaign_id', { count: 'exact', head: true })
    .eq('project_id', project.id);
  if (error) throw new Error(`Portal project campaign links read failed: ${error.message}`);
  if (typeof count !== 'number' || !Number.isSafeInteger(count)) {
    throw new Error('Portal project campaign links count is unavailable');
  }
  if (count > 0) return null;
  const exact = exactCount(fact);
  return portalProjectTermIssue(
    'PORTAL_PROJECT_MANUAL_FACT',
    PORTAL_TERM_TEXT.manualFact(exact === null ? fact : exact.toLocaleString('ru-RU')),
  );
}

/**
 * Как карточка проекта без периодов: ручная связка проекта с кампанией
 * (project_instantly_campaigns), чтобы ночная синхронизация посчитала её в
 * projects.contacts_done, а ответы попали в проект. Сначала общая проверка
 * всех кампаний, чтобы не захватить только часть. Возвращает конфликты;
 * пустой список — все кампании за проектом.
 */
export async function claimProjectCampaignLinks(
  instantlyDb: SupabaseClient,
  portalProjectId: string,
  campaignIds: string[],
  matchReason: string,
  deps: {
    check?: typeof checkCampaignProjectOwnershipConflicts;
    claim?: typeof claimCampaignProjectOwnership;
  } = {},
): Promise<CampaignProjectOwnershipConflict[]> {
  const check = deps.check ?? checkCampaignProjectOwnershipConflicts;
  const claim = deps.claim ?? claimCampaignProjectOwnership;
  const conflicts = await check(instantlyDb, portalProjectId, campaignIds);
  if (conflicts.length > 0) return conflicts;
  for (const campaignId of campaignIds) {
    const result = await claim(instantlyDb, {
      projectId: portalProjectId,
      campaignId,
      matchSource: 'manual',
      periodId: null,
      matchConfidence: 1,
      matchReason,
      replaceAutomatic: false,
    });
    if (result.status === 'conflict') {
      return [{ campaignId, conflictingProjectIds: result.conflictingProjectIds }];
    }
  }
  return [];
}

export function describeOwnershipConflicts(conflicts: CampaignProjectOwnershipConflict[]): string {
  return conflicts
    .map((conflict) => `${conflict.campaignId} → ${conflict.conflictingProjectIds.join(', ') || 'unknown project'}`)
    .join('; ');
}
