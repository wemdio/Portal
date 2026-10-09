/**
 * Автоподъём ENG-базы, легшей на ВРЕМЕННОМ отказе провайдера.
 *
 * Тонкая обёртка над RPC `he_auto_resume_transient_bases`
 * (supabase/migrations/20260929_0001_he_base_transient_resume.sql). Ни одного
 * решения здесь НЕТ и быть не должно: все условия подъёма — рынок 'us', отмена
 * клиентом (по статусу джобы, не по тексту), refill, решения самого движка,
 * перманентный отказ провайдера, занятая вертикаль, потолок подъёмов — живут в
 * SQL. Причина та же, что у V2: проход зовёт ночной крон, а базу параллельно
 * может трогать воркер, и «прочитать в TS, решить в TS, записать в TS» — это
 * гонка, в которой база поднимается дважды. Здесь остаются только флаг,
 * нормализация ответа и счёт для лога — и одно решение уровня «идти ли проходу
 * вообще»: при включённом потолке расхода (spendCeiling.ts, по умолчанию
 * выключен) прохода нет целиком, потому что внутрь SQL проверку потолка по
 * проекту не встроить без миграции (см. HeAutoResumeSummary.skipped).
 *
 * Читатель — app/worker/heAutoPipelineCron.ts (единственный): ночной крон
 * ENG-конвейера, проход идёт ПЕРЕД постановкой доливов.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { heSpendCeilingOn, readHeSpendCaps } from './spendCeiling';

/**
 * Флаг включения. По умолчанию проход ВЫКЛЮЧЕН: у ENG нет живого клиентского
 * трафика, ночной добор в production ещё не запускался ни разу, а подъём базы
 * стоит денег (новая джоба сборки = ещё до MAX_ATTEMPTS прогонов стадии).
 * Включать осознанно и только вместе с применённой миграцией.
 */
export const HE_AUTO_RESUME_FLAG_ENV = 'HE_AUTO_RESUME_TRANSIENT';

/**
 * Потолок подъёмов ОДНОЙ базы — пожизненный, не оконный.
 *
 * В V2 лимит сделали оконным (20260921_0002_ve_auto_resume_window.sql), потому
 * что там подготовка копит контакты между подъёмами и здоровая база обязана
 * жить сколько нужно. Здесь наоборот: подъём может заново оплатить построение
 * плана (LLM + проба среза), если прошлый прогон не дожил до записи плана в
 * collect_info. Поэтому счётчик he_bases.auto_resumes только растёт, и третий
 * подъём одной базы не случится никогда — дальше решает человек.
 */
export const HE_AUTO_RESUME_MAX_PER_BASE = 2;

/** Сколько баз проход поднимает за одну ночь (отказы в это число не входят). */
export const HE_AUTO_RESUME_PER_RUN = 5;

/** Остывание между двумя подъёмами одной базы. */
export const HE_AUTO_RESUME_MIN_AGE_MINUTES = 10;

/**
 * Окно кандидатов: база, упавшая больше трёх суток назад, не поднимается.
 * Временный отказ провайдера к этому времени давно кончился, а клиенту кабинет
 * уже сказал перезапустить шаг — воскрешать за него неделю спустя незачем.
 * Это же окно держит ночной лог коротким: отказы логируются только по
 * кандидатам внутри него.
 */
export const HE_AUTO_RESUME_MAX_AGE_HOURS = 72;

/** 'resumed' — база вернулась в сборку; 'refused' — не тронута, причина в reason. */
export type HeAutoResumeOutcome = 'resumed' | 'refused';

export interface HeAutoResumeRow {
  baseId: string;
  projectId: string | null;
  verticalId: string | null;
  outcome: HeAutoResumeOutcome;
  /**
   * Машинная причина отказа: 'resume_cap' (потолок подъёмов базы), 'cooldown'
   * (подняли только что), 'vertical_collecting' (у вертикали уже собирается
   * другая база — partial unique index), 'vertical_analyzing' / 'vertical_analyzed'
   * (сборка вертикали УЖЕ удалась другой базой — клиент перезапустил шаг сам),
   * 'superseded' (у вертикали есть более молодая не-refill база), 'raced' (строка
   * изменилась между выборкой и записью), 'sql_<SQLSTATE>' (запись откатилась
   * целиком). Список задаёт SQL (миграция 20260929_0001), тип — свободная строка:
   * новая причина доезжает до лога крона без правки этого файла.
   */
  reason: string | null;
  /** Значение he_bases.auto_resumes ПОСЛЕ этого прохода. */
  resumes: number;
  /** id вставленной he_jobs base_collect (только у 'resumed'). */
  jobId: string | null;
}

export interface HeAutoResumeSummary {
  /** false — флаг не выставлен (или проход пропущен, см. skipped), RPC не звали вовсе. */
  enabled: boolean;
  /**
   * Флаг выставлен, но проход пропущен целиком: включён потолок расхода
   * us-проекта (spendCeiling.ts; по умолчанию выключен). RPC сам выбирает базы
   * и сам ставит их сборку внутри SQL, а проверить потолок по проекту между
   * выбором и постановкой там нечем без новой миграции. Поэтому при включённом
   * потолке автоподъём не идёт вовсе: упавшую базу поднимает человек, а его
   * кнопки потолок проверяют (клиентская) или сознательно нет (staff).
   */
  skipped?: 'spend_ceiling';
  resumed: number;
  refused: number;
  rows: HeAutoResumeRow[];
}

/** Включён ли проход. Пустое/нераспознанное значение = выключен. */
export function heAutoResumeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[HE_AUTO_RESUME_FLAG_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Строка ответа RPC → типизированная. Всё, у чего нет base_id, отбрасываем:
 * такую строку не о чем логировать. Неизвестный outcome считаем отказом —
 * «поднято» обязано быть сказано явно, иначе счёт в логе врёт.
 */
function normalizeRow(raw: unknown): HeAutoResumeRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const baseId = asString(row.base_id);
  if (!baseId) return null;
  const resumes = typeof row.resumes === 'number' && Number.isSafeInteger(row.resumes) ? row.resumes : 0;
  return {
    baseId,
    projectId: asString(row.project_id),
    verticalId: asString(row.vertical_id),
    outcome: row.outcome === 'resumed' ? 'resumed' : 'refused',
    reason: asString(row.reason),
    resumes,
    jobId: asString(row.job_id),
  };
}

/**
 * Один проход автоподъёма.
 *
 * Бросает ошибку наверх (в том числе «функции нет» — PGRST202, если флаг
 * включили без миграции): вызывающий крон обязан сказать об этом громко, но
 * постановку ночных доливов из-за этого не терять.
 */
export async function runHeAutoResumeTransientPass(
  supabase: SupabaseClient,
  opts: {
    limit?: number;
    maxResumes?: number;
    minAgeMinutes?: number;
    maxAgeHours?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<HeAutoResumeSummary> {
  if (!heAutoResumeEnabled(opts.env ?? process.env)) {
    return { enabled: false, resumed: 0, refused: 0, rows: [] };
  }
  // Подъём базы — новая платная сборка (потолок проверяет такую постановку
  // на каждом машинном и клиентском пути), а RPC ставит её внутри SQL, куда проверку
  // потолка не встроить без миграции. Потолок включён — прохода нет (см.
  // HeAutoResumeSummary.skipped). Выключен (дефолт) — прежнее поведение.
  if (heSpendCeilingOn(readHeSpendCaps(opts.env ?? process.env))) {
    return { enabled: false, skipped: 'spend_ceiling', resumed: 0, refused: 0, rows: [] };
  }

  const { data, error } = await supabase.rpc('he_auto_resume_transient_bases', {
    p_limit: opts.limit ?? HE_AUTO_RESUME_PER_RUN,
    p_max_resumes: opts.maxResumes ?? HE_AUTO_RESUME_MAX_PER_BASE,
    p_min_age_minutes: opts.minAgeMinutes ?? HE_AUTO_RESUME_MIN_AGE_MINUTES,
    p_max_age_hours: opts.maxAgeHours ?? HE_AUTO_RESUME_MAX_AGE_HOURS,
  });
  if (error) throw new Error(`he_auto_resume_transient_bases: ${error.message}`);

  const rows = (Array.isArray(data) ? data : [])
    .map((raw: unknown) => normalizeRow(raw))
    .filter((row): row is HeAutoResumeRow => row !== null);

  return {
    enabled: true,
    resumed: rows.filter((r) => r.outcome === 'resumed').length,
    refused: rows.filter((r) => r.outcome === 'refused').length,
    rows,
  };
}
