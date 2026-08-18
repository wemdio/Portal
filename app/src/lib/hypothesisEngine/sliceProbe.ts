/**
 * Проба каталожного среза: до сбора проверяем, что срез действительно состоит
 * из компаний вертикали, а не просто валиден фирмографически.
 *
 * Зачем отдельно от relevanceGate. Гейт — фильтр грубого шума на готовой базе,
 * и у него ОСОЗНАННО низкая полнота: «сомневаешься — оставляй строку». Под
 * вертикалью «Franchise Brands» ресторан с меткой `restaurants` не является
 * «явно НЕ франшизой», поэтому остаётся. Так и вышло 12.08: планировщик взял
 * широкие индустрии, гейт срезал 569 строк из 2000, а в базе всё равно осели
 * не франчайзеры, а рестораны, школы и YMCA.
 *
 * Отсюда главное решение: проба задаёт ОБРАТНЫЙ вопрос — «принадлежит ли
 * компания вертикали?», и сомнение падает в «нет». Одна и та же модель на одних
 * и тех же строках даёт противоположный ответ в зависимости от того, куда
 * направлен дефолт; для пред-полётной проверки он обязан быть отрицательным,
 * иначе проба унаследует слепоту гейта и подтвердит любой срез.
 *
 * Дёшево: одна пачка строк на gate-модели. Против часа конструктора и рассылки
 * не тем людям — цена пренебрежимая.
 */

import { z } from 'zod';
import { callLLMWithSchema, getHeModel, type LLMMessage } from './llm';

/**
 * Число из env с ЧЕСТНЫМ нулём: `Number(x) || d` роняет 0 в дефолт, потому что
 * ноль ложен. Для порога отказа это была дыра в предохранителе — выставить 0,
 * чтобы отключить отказ, было невозможно.
 */
function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/** Сколько строк среза показываем модели. */
export function sliceProbeSample(): number { return envNum('HE_SLICE_PROBE_SAMPLE', 30); }

/**
 * ДВА РАЗНЫХ ПОРОГА, оба по умолчанию 0 — то есть проба МЕРЯЕТ И ПИШЕТ, но сама
 * ничего не решает. Так вышло после калибровки 18.08 на боевых срезах:
 *
 *   срез                                gpt-4o-mini   gpt-5.5
 *   Healthcare (эталон, база сдана)          23%         0%
 *   Franchise, широкие индустрии (брак)       0%         3%
 *   Franchise по названию (рабочий)          27%        30%
 *   Legal (отказ был верным)                  0%         0%
 *   Industrial Suppliers                     80%         0%
 *
 * При пороге 0.3 машина забраковала бы ОБА рабочих среза, включая Healthcare —
 * лучшую базу проекта. Хуже того, сильная модель меняет вердикт на
 * противоположный: Industrial 80% против 0%. Измерение, переворачивающееся от
 * смены модели, измерением не является — проба в нынешнем виде меряет
 * уверенность модели, а не пригодность среза, потому что судит компанию по
 * названию и отраслевой метке, а дефолт стоит на «не принадлежит».
 *
 * Пока вопрос пробы не переделан, действовать на её числах нельзя. Провенанс
 * при этом ценен и продолжает писаться в collect_info.slice_probe.
 * Включается осознанно: HE_SLICE_PROBE_REPAIR_BELOW / _REJECT_BELOW.
 */
/* Функции, а не константы: значение, прочитанное при импорте, нельзя было бы
   поменять на проде без пересборки контейнера — а это предохранитель. */
export function sliceProbeRepairBelow(): number { return envNum('HE_SLICE_PROBE_REPAIR_BELOW', 0); }
export function sliceProbeRejectBelow(): number { return envNum('HE_SLICE_PROBE_REJECT_BELOW', 0); }

const ProbeSchema = z.object({
  /** Индексы строк, чья компания ПРИНАДЛЕЖИТ вертикали (0-based). */
  belongs: z.array(z.number().int()).default([]),
});

export interface SliceProbeResult {
  sampled: number;
  matched: number;
  /** matched / sampled; 0 при пустой выборке. */
  hitRate: number;
  /** Примеры компаний, НЕ признанных принадлежащими вертикали — объяснение решения. */
  offTargetExamples: string[];
  tokensUsed: number;
  costUsd: number;
}

function buildProbeMessages(
  verticalName: string,
  verticalSummary: string,
  batch: Array<{ i: number; company: string; website: string; category: string }>,
): LLMMessage[] {
  return [
    {
      role: 'system',
      content:
        'You audit whether a sampled slice of a company catalog actually consists of companies of a given sales vertical. ' +
        'A row counts ONLY if the company itself is a member of the vertical — not merely operating in a related industry, ' +
        'not a supplier to it, not a consultancy or media covering it. ' +
        'Default to NOT belonging: when you are unsure, leave the row out. Answer strictly in JSON.',
    },
    {
      role: 'user',
      content: `Vertical: «${verticalName}»${verticalSummary ? ` — ${verticalSummary}` : ''}

Sampled rows (i + fields):
${JSON.stringify(batch)}

Return JSON {"belongs": [<i>, ...]} listing ONLY the indices whose company clearly belongs to this vertical. Unsure — omit the index.`,
    },
  ];
}

/**
 * Проверить выборку среза на принадлежность вертикали.
 * Never-throw: сбой модели → hitRate=0 и sampled=0, вызывающий трактует это как
 * «проба не состоялась» и НЕ отбраковывает срез (иначе временный сбой LLM
 * рубил бы рабочие вертикали).
 */
export async function probeSliceRelevance(input: {
  rows: Array<{ company?: unknown; website?: unknown; category?: unknown }>;
  verticalName: string;
  verticalSummary?: string;
  log?: (msg: string) => void;
}): Promise<SliceProbeResult> {
  const { rows, verticalName, verticalSummary = '', log } = input;
  const empty: SliceProbeResult = {
    sampled: 0,
    matched: 0,
    hitRate: 0,
    offTargetExamples: [],
    tokensUsed: 0,
    costUsd: 0,
  };
  const sample = rows.slice(0, sliceProbeSample());
  if (sample.length === 0 || !verticalName.trim()) return empty;

  const batch = sample.map((r, i) => ({
    i,
    company: String(r.company ?? '').slice(0, 120),
    website: String(r.website ?? '').slice(0, 80),
    category: String(r.category ?? '').slice(0, 80),
  }));

  try {
    const llm = await callLLMWithSchema(
      buildProbeMessages(verticalName, verticalSummary, batch),
      ProbeSchema,
      { model: getHeModel('gate'), maxTokens: 2048 },
    );
    const belongs = Array.isArray((llm.data as { belongs?: unknown[] } | undefined)?.belongs)
      ? (llm.data as { belongs: unknown[] }).belongs
      : null;
    if (!belongs) {
      log?.('[sliceProbe] ответ без belongs — проба не состоялась');
      return empty;
    }
    const hit = new Set(
      belongs.filter((v): v is number => typeof v === 'number' && v >= 0 && v < batch.length),
    );
    return {
      sampled: batch.length,
      matched: hit.size,
      hitRate: batch.length > 0 ? hit.size / batch.length : 0,
      offTargetExamples: batch.filter((b) => !hit.has(b.i)).slice(0, 5).map((b) => b.company),
      tokensUsed: llm.tokensUsed,
      costUsd: llm.costUsd,
    };
  } catch (e) {
    log?.(`[sliceProbe] проба не состоялась: ${e instanceof Error ? e.message : String(e)}`);
    return empty;
  }
}
