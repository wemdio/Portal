/**
 * Стадия template: база + вертикаль + цепочка → финальный шаблон 85/15.
 *  1) LLM-план (fixed_block ~85% + personalization_plan + segment_additions);
 *  2) LLM финальных писем по плану (маркеры ---LETTER N---, letterParser);
 *  3) pure-маппинг операторов {{var}} финальных писем на колонки базы;
 *  4) insert в he_templates (status 'ready').
 */

import { parseLettersFromModelOutput } from '@/lib/emailSequenceV2/letterParser';
import { callLLMText, callLLMWithSchema, getHeModel, type LLMMessage } from '../llm';
import { HeBaseAnalysisSchema, HeTemplatePlanSchema, type HeBaseAnalysisOutput } from '../schemas';
import { buildTemplateLettersMessages, buildTemplatePlanMessages } from '../prompts/template';
import type {
  HeBase,
  HeChain,
  HeChainLanguage,
  HeChainLetter,
  HeJob,
  HeOperatorMapping,
  HePersonalizationPlan,
  HeVertical,
} from '../types';
import { parsedToChainLetters } from './chain';
import {
  addUsage,
  newUsage,
  payloadString,
  stageLog,
  type HeStageContext,
  type HeStageResult,
} from './shared';

/* ───────────────── Pure-часть: операторы персонализации ───────────────── */

const OPERATOR_RE = /\{\{\s*([A-Za-zА-Яа-яЁё0-9_.-]+)\s*\}\}/g;

/** Все уникальные операторы {{var}} в тексте, в порядке первого появления. */
export function extractPersonalizationOperators(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(OPERATOR_RE)) {
    const name = (m[1] ?? '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[{}]/g, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactKey(s: string): string {
  return normalizeKey(s).replace(/\s+/g, '');
}

/**
 * Словарь синонимов: компактный ключ оператора → возможные названия колонок
 * (тоже нормализуются через normalizeKey). Покрывает типичные CSV-базы
 * специалистов (ru/en наименования колонок).
 */
const OPERATOR_ALIASES: Record<string, string[]> = {
  firstname: ['имя', 'имя лида', 'first name', 'name'],
  lastname: ['фамилия', 'last name', 'surname'],
  fullname: ['фио', 'имя фамилия', 'full name', 'контакт'],
  name: ['имя', 'фио', 'контакт'],
  companyname: ['компания', 'название компании', 'company', 'company name', 'организация', 'бренд'],
  company: ['компания', 'название компании', 'company name', 'организация'],
  website: ['сайт', 'сайт компании', 'site', 'домен', 'url', 'website', 'веб сайт'],
  site: ['сайт', 'сайт компании', 'website', 'домен', 'url'],
  email: ['email', 'e mail', 'почта', 'эл почта', 'электронная почта', 'емейл'],
  phone: ['телефон', 'тел', 'phone', 'номер телефона'],
  position: ['должность', 'position', 'title', 'job title', 'роль', 'позиция'],
  jobtitle: ['должность', 'position', 'title', 'роль', 'позиция'],
  city: ['город', 'city', 'населенный пункт'],
  region: ['регион', 'region', 'область'],
  industry: ['отрасль', 'индустрия', 'industry', 'ниша'],
  segment: ['сегмент', 'segment'],
};

/**
 * Маппит операторы на колонки базы: точное совпадение (нормализованное),
 * затем таблица синонимов, затем подстрока в любую сторону. Не нашлось —
 * matched=false, column=null (специалист увидит дыру в плане).
 */
export function mapOperatorsToColumns(operators: string[], columns: string[]): HeOperatorMapping[] {
  const normalizedColumns = columns.map((column) => ({ column, norm: normalizeKey(column) }));

  return operators.map((operator) => {
    const candidates = [normalizeKey(operator)];
    for (const alias of OPERATOR_ALIASES[compactKey(operator)] ?? []) {
      candidates.push(normalizeKey(alias));
    }

    for (const cand of candidates) {
      const exact = normalizedColumns.find((c) => c.norm === cand);
      if (exact) return { operator, column: exact.column, matched: true };
    }
    for (const cand of candidates) {
      if (cand.length < 3) continue;
      const partial = normalizedColumns.find(
        (c) => c.norm.includes(cand) || (c.norm.length >= 3 && cand.includes(c.norm)),
      );
      if (partial) return { operator, column: partial.column, matched: true };
    }
    return { operator, column: null, matched: false };
  });
}

/* ───────────────── Стадия ───────────────── */

const RETRY_HINT = `Ты вернул слишком мало писем или нарушил формат. Нужно столько же писем, сколько в исходной цепочке (3–5), каждое блоком «---LETTER N---» + строка темы. Верни шаблон заново, целиком, без пояснений.`;

export async function runTemplateStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();
  const baseId = payloadString(job, 'base_id');

  const { data: baseRow, error: bError } = await ctx.supabase
    .from('he_bases')
    .select('*')
    .eq('id', baseId)
    .single();
  if (bError || !baseRow) throw new Error(`he_bases ${baseId}: ${bError?.message ?? 'not found'}`);
  const base = baseRow as HeBase;

  const analysisParsed = HeBaseAnalysisSchema.safeParse(base.analysis);
  if (!analysisParsed.success) {
    throw new Error('he_bases.analysis отсутствует или битый: сначала выполните стадию base_analyze');
  }
  const analysis: HeBaseAnalysisOutput = analysisParsed.data;

  const { data: verticalRow, error: vError } = await ctx.supabase
    .from('he_verticals')
    .select('*')
    .eq('id', base.vertical_id)
    .single();
  if (vError || !verticalRow) throw new Error(`he_verticals ${base.vertical_id}: ${vError?.message ?? 'not found'}`);
  const vertical = verticalRow as HeVertical;

  const { data: chainRow, error: cError } = await ctx.supabase
    .from('he_chains')
    .select('*')
    .eq('vertical_id', base.vertical_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (cError) throw new Error(`he_chains read: ${cError.message}`);
  if (!chainRow) throw new Error('Нет цепочки вертикали: сначала выполните стадию chain');
  const chain = chainRow as HeChain;
  const chainLetters = (Array.isArray(chain.letters) ? chain.letters : []) as HeChainLetter[];
  if (!chainLetters.length) throw new Error('he_chains.letters пуст — перегенерируйте цепочку');

  // Шаг 1: план 85/15.
  const plan = await callLLMWithSchema(
    buildTemplatePlanMessages({
      verticalName: vertical.name,
      verticalSummary: vertical.summary ?? '',
      chainLetters,
      baseAnalysis: analysis,
      columns: Array.isArray(base.columns) ? base.columns : [],
    }),
    HeTemplatePlanSchema,
    { model: getHeModel('chain'), maxTokens: 8192 },
  );
  addUsage(usage, plan);

  // Шаг 2: финальные письма по плану.
  const language = (chain.language === 'en' || chain.language === 'pl' ? chain.language : 'ru') as HeChainLanguage;
  const model = getHeModel('chain');
  const messages = buildTemplateLettersMessages({
    language,
    plan: plan.data,
    verticalName: vertical.name,
    chainLetters,
    baseAnalysis: analysis,
  });

  let llm = await callLLMText(messages, { model, maxTokens: 6144 });
  addUsage(usage, llm);
  let parsed = parseLettersFromModelOutput(llm.text);

  if (parsed.length < 3) {
    stageLog(ctx, `[template] распознано ${parsed.length} писем — retry с фидбэком`);
    const retryMessages: LLMMessage[] = [
      ...messages,
      { role: 'assistant', content: llm.text.slice(0, 2000) },
      { role: 'user', content: RETRY_HINT },
    ];
    llm = await callLLMText(retryMessages, { model, maxTokens: 6144 });
    addUsage(usage, llm);
    parsed = parseLettersFromModelOutput(llm.text);
  }
  if (parsed.length < 3) {
    throw new Error(`Шаблон не распарсился: ${parsed.length} писем после retry`);
  }

  // Шаг 3: операторы финальных писем → колонки базы (pure).
  const letters = parsedToChainLetters(parsed.slice(0, 6));
  const allText = letters.map((l) => `${l.subject ?? ''}\n${l.body}`).join('\n');
  const operatorMapping = mapOperatorsToColumns(
    extractPersonalizationOperators(allText),
    Array.isArray(base.columns) ? base.columns : [],
  );

  const personalizationPlan: HePersonalizationPlan = {
    letters: plan.data.personalization_plan,
    additions: plan.data.segment_additions,
    operator_mapping: operatorMapping,
  };

  const { data: inserted, error: insError } = await ctx.supabase
    .from('he_templates')
    .insert({
      base_id: baseId,
      vertical_id: base.vertical_id,
      fixed_block: plan.data.fixed_block,
      personalization_plan: personalizationPlan,
      letters,
      status: 'ready',
      tokens_used: usage.tokensUsed,
      cost_usd: usage.costUsd,
    })
    .select('id')
    .single();
  if (insError || !inserted) throw new Error(`he_templates insert: ${insError?.message ?? 'unknown'}`);

  return {
    result: {
      template_id: (inserted as { id: string }).id,
      fixed_block: plan.data.fixed_block,
      personalization_plan: personalizationPlan,
      letters,
    },
    tokensUsed: usage.tokensUsed,
    costUsd: usage.costUsd,
  };
}
