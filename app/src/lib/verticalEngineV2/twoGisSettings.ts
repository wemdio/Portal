import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Настройки 2ГИС для VE2 (таблица ve_twogis_source_settings, шаг R2 плана
 * docs/reports/2026-10-26-2gis-ve2-plan.md). Без воркерных зависимостей: модуль
 * читают и портал (новое превью, выдача), и воркер. Сбой чтения — null: это
 * «неизвестно», а не «выключено». Флаг не ставится и строки 2ГИС не выдаются, но
 * близнец не закрывается, а откладывается (необратимо закрывает только mode=off).
 */
export interface VeTwoGisSettings {
  mode: 'off' | 'on';
  reads_enabled: boolean;
  client_use: 'off' | 'internal' | 'all';
  internal_projects: string[];
  excluded_projects: string[];
  /** 'HH:MM[:SS]' UTC; start > end — окно через полночь. */
  quiet_start_utc: string;
  quiet_end_utc: string;
  max_candidates: number | null;
  snapshot_id: number | null;
  features_version: number | null;
  built_at: string | null;
  mode_changed_at: string | null;
  reads_changed_at: string | null;
  client_use_changed_at: string | null;
}

const SELECT = 'mode, reads_enabled, client_use, internal_projects, excluded_projects, quiet_start_utc, quiet_end_utc, '
  + 'max_candidates, snapshot_id, features_version, built_at, mode_changed_at, reads_changed_at, client_use_changed_at';
const TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

const text = (value: unknown) => (typeof value === 'string' ? value : null);
const strings = (value: unknown) => (Array.isArray(value) && value.every((item) => typeof item === 'string') ? value as string[] : null);
const count = (value: unknown) => (value == null ? null : Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined);
const minutesOf = (value: string) => {
  const match = TIME.exec(value)!;
  return Number(match[1]) * 60 + Number(match[2]);
};
/** Окно считается в минутах: секунды в настройке — ошибка, а не «округлим». */
const wholeMinute = (value: string) => {
  const match = TIME.exec(value);
  return !!match && (match[3] ?? '00') === '00';
};

/** Строка из БД → настройки; что-то не так — null (неизвестно), а не догадка. */
export function parseVeTwoGisSettings(row: unknown): VeTwoGisSettings | null {
  return parseWithProblem(row).settings;
}

function parseWithProblem(row: unknown): { settings: VeTwoGisSettings | null; problem: string | null } {
  const invalid = (field: string) => ({ settings: null, problem: `invalid:${field}` });
  if (!row || typeof row !== 'object') return { settings: null, problem: 'missing_row' };
  const value = row as Record<string, unknown>;
  const internal = strings(value.internal_projects);
  const excluded = strings(value.excluded_projects);
  const start = text(value.quiet_start_utc);
  const end = text(value.quiet_end_utc);
  const maxCandidates = count(value.max_candidates);
  const snapshot = count(value.snapshot_id);
  const features = count(value.features_version);
  if (value.mode !== 'off' && value.mode !== 'on') return invalid('mode');
  if (typeof value.reads_enabled !== 'boolean') return invalid('reads_enabled');
  if (value.client_use !== 'off' && value.client_use !== 'internal' && value.client_use !== 'all') return invalid('client_use');
  if (!internal) return invalid('internal_projects');
  if (!excluded) return invalid('excluded_projects');
  if (!start || !end || !wholeMinute(start) || !wholeMinute(end) || minutesOf(start) === minutesOf(end)) return invalid('quiet_window');
  if (maxCandidates === undefined) return invalid('max_candidates');
  if (snapshot === undefined) return invalid('snapshot_id');
  if (features === undefined) return invalid('features_version');
  return { problem: null, settings: {
    mode: value.mode, reads_enabled: value.reads_enabled, client_use: value.client_use,
    internal_projects: internal, excluded_projects: excluded, quiet_start_utc: start, quiet_end_utc: end,
    max_candidates: maxCandidates, snapshot_id: snapshot, features_version: features, built_at: text(value.built_at),
    mode_changed_at: text(value.mode_changed_at), reads_changed_at: text(value.reads_changed_at),
    client_use_changed_at: text(value.client_use_changed_at),
  } };
}

/** Строка 'ru'. Нет таблицы (до деплоя R2), нет строки, ошибка — null и строка в лог (только вид, без значений). */
export async function readVeTwoGisSettings(db: SupabaseClient): Promise<VeTwoGisSettings | null> {
  let problem: string;
  try {
    const { data, error } = await db.from('ve_twogis_source_settings').select(SELECT).eq('market', 'ru').maybeSingle();
    if (error) problem = `read:${error.code ?? 'error'}`;
    else {
      const parsed = parseWithProblem(data);
      if (parsed.settings) return parsed.settings;
      problem = parsed.problem ?? 'unknown';
    }
  } catch (error) {
    problem = `read:${error instanceof Error ? error.name : 'error'}`;
  }
  console.warn(`[ve2-2gis] settings unreadable: ${problem}`);
  return null;
}

/**
 * Выдача строк 2ГИС проекту. open; closed — аварийное client_use='off' (отсрочка,
 * через сутки близнец закрывается, можно открыть обратно); removed — проект
 * исключён или не в списке (близнец закрывается сразу); unknown — настройки не
 * прочитались (временно «не разрешено»).
 */
export type VeTwoGisOutputState = 'open' | 'closed' | 'removed' | 'unknown';

export function veTwoGisOutputState(settings: VeTwoGisSettings | null, projectId: string): VeTwoGisOutputState {
  if (!settings || !projectId) return 'unknown';
  if (settings.client_use === 'off') return 'closed';
  if (settings.client_use === 'all') return settings.excluded_projects.includes(projectId) ? 'removed' : 'open';
  return settings.internal_projects.includes(projectId) ? 'open' : 'removed';
}

/** Выдача строк 2ГИС проекту: all — всем, кроме excluded_projects; internal — только internal_projects. */
export function veTwoGisOutputOpen(settings: VeTwoGisSettings | null, projectId: string): boolean {
  return veTwoGisOutputState(settings, projectId) === 'open';
}

/** Снимок для чтения проверен сборкой (шаг Ш5): без него флаг заморозил бы пустой снимок. */
export const veTwoGisSnapshotReady = (settings: VeTwoGisSettings | null) =>
  !!settings && settings.snapshot_id != null && settings.features_version != null && settings.built_at != null;

/** Флаг 2ГИС новому RU-превью: 2ГИС включён, снимок собран и выдача проекту открыта. */
export function veTwoGisFlagAllowed(settings: VeTwoGisSettings | null, projectId: string): boolean {
  return settings?.mode === 'on' && veTwoGisSnapshotReady(settings) && veTwoGisOutputOpen(settings, projectId);
}

/** Конец тихого окна, если now внутри него, иначе null. Окно [start, end) по UTC, start > end — через полночь. */
export function veTwoGisQuietUntil(settings: VeTwoGisSettings, now: Date): Date | null {
  const start = minutesOf(settings.quiet_start_utc);
  const end = minutesOf(settings.quiet_end_utc);
  const current = now.getUTCHours() * 60 + now.getUTCMinutes();
  const inside = start < end ? current >= start && current < end : current >= start || current < end;
  if (!inside) return null;
  const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Math.floor(end / 60), end % 60));
  if (until.getTime() <= now.getTime()) until.setUTCDate(until.getUTCDate() + 1);
  return until;
}

/**
 * Причина на уровне настроек (без проекта: выдачу проекту даёт veTwoGisOutputState).
 * off — mode=off, необратимо; settings_unavailable — не прочитались, отсрочка.
 */
export type VeTwoGisReadBlock = { reason: 'off' } | { reason: 'settings_unavailable' } | { reason: 'not_built' }
  | { reason: 'reads_disabled' } | { reason: 'quiet'; until: Date };

/** Почему читать 2ГИС сейчас нельзя; null — можно. */
export function veTwoGisReadBlock(settings: VeTwoGisSettings | null, now: Date): VeTwoGisReadBlock | null {
  if (!settings) return { reason: 'settings_unavailable' };
  if (settings.mode !== 'on') return { reason: 'off' };
  if (!veTwoGisSnapshotReady(settings)) return { reason: 'not_built' };
  if (!settings.reads_enabled) return { reason: 'reads_disabled' };
  const until = veTwoGisQuietUntil(settings, now);
  return until ? { reason: 'quiet', until } : null;
}
