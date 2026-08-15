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

/** Сколько строк среза показываем модели. Хватает, чтобы отличить 5% от 60%. */
export const SLICE_PROBE_SAMPLE = Number(process.env.HE_SLICE_PROBE_SAMPLE) || 30;

/**
 * Доля попадания, ниже которой срез считаем непригодным. Не 100%: релевант-гейт
 * дальше всё равно чистит остаток, база не обязана быть идеальной. Но на 10%
 * попадания срез бесполезен — гейт столько шума не вытянет.
 */
export const SLICE_PROBE_MIN_HIT_RATE = Number(process.env.HE_SLICE_PROBE_MIN_HIT_RATE) || 0.3;

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
  const sample = rows.slice(0, SLICE_PROBE_SAMPLE);
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
