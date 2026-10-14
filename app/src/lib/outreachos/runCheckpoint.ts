/**
 * Контрольные точки ежедневного прогона OutreachOS (инцидент 23–24.09.2026).
 *
 * Прогон идёт как `docker exec portal-worker-hh node …/outreachosCron.js`, и
 * деплой, пересоздающий контейнер, убивает его без строчки в логе. После
 * полного обхода HH прогон длится ~2,5 ч (HH ~55 мин + конструктор ~65 мин),
 * так что под деплой он попадает легко. Всё состояние между фазами жило в
 * памяти и пропадало вместе с процессом — даже готовое задание конструктора.
 *
 * Две точки (таблица outreachos_run_checkpoints, одна строка на прогон):
 *   constructor — HH собран и отфильтрован, задание конструктора создано (или
 *                 новых компаний нет). Продолжение ждёт то же задание вместо
 *                 повторных HH и конструктора.
 *   upload      — LLM и 2GIS отработали, лиды собраны, seen ещё не записан.
 *                 Продолжение повторяет markSeen (upsert идемпотентен) и
 *                 заливку; лиды, уже попавшие в A/B, отсекает обычный дедуп
 *                 против своих кампаний.
 *
 * Запись точки — best-effort: сбой не роняет прогон, просто продолжать будет
 * не с чего, и сторож закроет его как оборванный.
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { HhEmployer } from '@/lib/jobs/hhAutoParser';
import type { LeadCreatePayload } from '@/lib/instantly/types';
import type { SeenEmployerUpsert } from './seenEmployers';
import type { GisScanCheckpoint } from './gisScanState';

type Logger = (msg: string) => void;

const TABLE = 'outreachos_run_checkpoints';
export const CHECKPOINT_VERSION = 1;
/**
 * Классификатор всё равно режет контекст до 120 символов (classifyCompanies,
 * sanitize). Храним на символ больше: он режет после trim, и пробел на 120-й
 * позиции без запасного символа потерялся бы — промпт бы разошёлся.
 */
const CONTEXT_CHARS = 121;
/** Брошенные точки (прогон так и не продолжили) храним неделю для ручного разбора. */
export const CHECKPOINT_RETENTION_DAYS = 7;

export type CheckpointPhase = 'constructor' | 'upload';

/** HhEmployer без полей, которые после создания задания конструктора не нужны. */
export interface CheckpointEmployer {
  id: string;
  name: string;
  siteUrl: string | null;
  industries: string[];
  vacancyTitle?: string;
  description?: string;
}

/** Итоги HH-фазы — нужны run-строке при любом продолжении. */
export interface HhPhaseTotals {
  /** UTC-дата старта прогона 'YYYY-MM-DD' — имя GIS-задания конструктора. */
  runDate: string;
  parsed: number;
  afterIcp: number;
  newEmployers: number;
  baseJobId: string | null;
}

export interface ConstructorPayload extends HhPhaseTotals {
  version: typeof CHECKPOINT_VERSION;
  fresh: CheckpointEmployer[];
  /** Домены всего HH-батча: 2GIS не должен брать компании сегодняшнего HH. */
  batchDomains: string[];
}

export interface GisCounters {
  pulled: number;
  afterDedup: number;
  validContacts: number;
  llmKept: number;
  appended: number;
}

export interface UploadPayload extends HhPhaseTotals {
  version: typeof CHECKPOINT_VERSION;
  validContacts: number;
  llm: { noise: number; kept: number; failedBatches: number; guardTripped: boolean };
  keptLeads: LeadCreatePayload[];
  seenRows: SeenEmployerUpsert[];
  gis: {
    executed: boolean;
    measureOnly: boolean;
    counters: GisCounters;
    scanCheckpoint: GisScanCheckpoint | null;
    /** Сколько GIS-лидов прошло LLM (до объединения с HH). */
    keptLeadCount: number;
    keptDomains: string[];
    qualified: Array<{ twogisId: string; name: string; site: string }>;
  };
}

export type CheckpointState =
  | { phase: 'constructor'; payload: ConstructorPayload }
  | { phase: 'upload'; payload: UploadPayload };

export type RunCheckpoint = CheckpointState & { runId: string; resumeAttempts: number };

/** Заголовок точки без payload (он бывает мегабайтами) — для решения сторожа. */
export interface CheckpointHead {
  runId: string;
  phase: CheckpointPhase;
  resumeAttempts: number;
}

export function compactEmployer(e: HhEmployer): CheckpointEmployer {
  const clip = (s: string | undefined): string | undefined => {
    const v = s?.replace(/\s+/g, ' ').trim().slice(0, CONTEXT_CHARS);
    return v ? v : undefined;
  };
  return {
    id: e.id,
    name: e.name ?? '',
    siteUrl: e.siteUrl ?? null,
    industries: e.industries ?? [],
    vacancyTitle: clip(e.vacancyTitle),
    description: clip(e.description),
  };
}

export function restoreEmployer(e: CheckpointEmployer): HhEmployer {
  return {
    id: e.id,
    name: e.name,
    siteUrl: e.siteUrl,
    hhUrl: null,
    area: null,
    industries: e.industries ?? [],
    employeeCount: null,
    vacancyTitle: e.vacancyTitle,
    description: e.description,
  };
}

export async function saveRunCheckpoint(runId: string, state: CheckpointState, log: Logger): Promise<boolean> {
  try {
    if (!supabaseAdmin) throw new Error('supabaseAdmin unavailable');
    const { error } = await supabaseAdmin
      .from(TABLE)
      .upsert(
        { run_id: runId, phase: state.phase, payload: state.payload, updated_at: new Date().toISOString() },
        { onConflict: 'run_id' },
      );
    if (error) throw new Error(error.message);
    log(`[checkpoint] точка «${state.phase}» сохранена`);
    return true;
  } catch (err) {
    log(`[checkpoint] не удалось сохранить точку «${state.phase}», прогон продолжается: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function loadCheckpointHeads(runIds: string[]): Promise<Map<string, CheckpointHead>> {
  const heads = new Map<string, CheckpointHead>();
  if (!supabaseAdmin || runIds.length === 0) return heads;
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select('run_id, phase, resume_attempts, version:payload->version')
    .in('run_id', runIds);
  if (error) throw new Error(`checkpoint heads: ${error.message}`);
  for (const row of (data ?? []) as Array<{ run_id: string; phase: string; resume_attempts: number; version: unknown }>) {
    // Точку чужой версии кода не продолжаем: форма payload могла измениться.
    if (row.version !== CHECKPOINT_VERSION) continue;
    if (row.phase !== 'constructor' && row.phase !== 'upload') continue;
    heads.set(row.run_id, { runId: row.run_id, phase: row.phase, resumeAttempts: row.resume_attempts });
  }
  return heads;
}

export async function loadRunCheckpoint(runId: string): Promise<RunCheckpoint | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select('run_id, phase, payload, resume_attempts')
    .eq('run_id', runId)
    .maybeSingle();
  if (error) throw new Error(`checkpoint load: ${error.message}`);
  const row = data as { run_id: string; phase: string; payload: { version?: unknown } | null; resume_attempts: number } | null;
  if (!row || row.payload?.version !== CHECKPOINT_VERSION) return null;
  if (row.phase === 'constructor') {
    return { runId: row.run_id, resumeAttempts: row.resume_attempts, phase: 'constructor', payload: row.payload as ConstructorPayload };
  }
  if (row.phase === 'upload') {
    return { runId: row.run_id, resumeAttempts: row.resume_attempts, phase: 'upload', payload: row.payload as UploadPayload };
  }
  return null;
}

/**
 * Забрать прогон на продолжение: resume_attempts меняется сравнением со
 * старым значением, поэтому второй сторож, прочитавший ту же точку, получит false.
 */
export async function claimRunCheckpoint(runId: string, expectedAttempts: number): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .update({ resume_attempts: expectedAttempts + 1, updated_at: new Date().toISOString() })
    .eq('run_id', runId)
    .eq('resume_attempts', expectedAttempts)
    .select('run_id');
  if (error) throw new Error(`checkpoint claim: ${error.message}`);
  return (data ?? []).length === 1;
}

/** Прогон завершился штатно (completed/failed) — продолжать больше нечего. */
export async function deleteRunCheckpoint(runId: string, log: Logger): Promise<void> {
  try {
    if (!supabaseAdmin) return;
    const { error } = await supabaseAdmin.from(TABLE).delete().eq('run_id', runId);
    if (error) throw new Error(error.message);
  } catch (err) {
    log(`[checkpoint] не удалось удалить точку прогона ${runId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function pruneRunCheckpoints(log: Logger, now = new Date()): Promise<void> {
  try {
    if (!supabaseAdmin) return;
    const cutoff = new Date(now.getTime() - CHECKPOINT_RETENTION_DAYS * 86_400_000).toISOString();
    const { error } = await supabaseAdmin.from(TABLE).delete().lt('updated_at', cutoff);
    if (error) throw new Error(error.message);
  } catch (err) {
    log(`[checkpoint] не удалось почистить старые точки: ${err instanceof Error ? err.message : String(err)}`);
  }
}
