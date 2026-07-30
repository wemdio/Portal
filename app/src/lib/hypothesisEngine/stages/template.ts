/**
 * Стадия template: база + вертикаль + цепочка → финальный шаблон 85/15.
 *  1) LLM-план (fixed_block ~85% + personalization_plan + letters[].segment_variants);
 *  2) LLM финальных писем по плану (маркеры ---LETTER N--- + ---SEGMENT: <when>---,
 *     у письма 1 — A/B-вариант ---LETTER 1 B---): основной текст — дефолт для
 *     всей базы, сегментные варианты хранятся отдельно
 *     (letters[].segment_variants), B-вариант — в letters[].variants,
 *     wait_days — лесенка CHAIN_WAIT_DAYS из stages/chain;
 *  3) пост-проверки с одним retry каждая: длина тел (≤80 слов, письмо 1 ≤70) и
 *     консистентность operator_mapping (см. validateOperatorMapping);
 *  4) pure-маппинг операторов {{var}} финальных писем на колонки базы;
 *  5) insert в he_templates (status 'ready', llm_model).
 * В промпты подмешиваются style_override из брифа (styleExample) и
 * winner-паттерны датасета (best-effort); после генерации писем — критик-луп:
 * одна оценка (только основной вариант A) + максимум один rewrite по её
 * замечаниям; B-вариант и сегментные варианты после рерайта восстанавливаются
 * из исходных писем.
 */

import { parseLettersFromModelOutput, type ParsedLetter } from '@/lib/emailSequenceV2/letterParser';
import { callLLMText, callLLMWithSchema, getHeModel, type LLMMessage } from '../llm';
import {
  HeBaseAnalysisSchema,
  HeTemplatePlanSchema,
  type HeBaseAnalysisOutput,
  type HeTemplatePlanOutput,
} from '../schemas';
import {
  buildTemplateCriticMessages,
  buildTemplateLettersMessages,
  buildTemplatePlanMessages,
  buildTemplateRewriteMessages,
} from '../prompts/template';
import { selectCaseForVertical, type HeCase } from '../caseBank';
import { getWinnerPatterns, matchSegmentLabels, type HeWinnerPattern } from '../datasetStats';
import type {
  HeBase,
  HeChain,
  HeChainLanguage,
  HeChainLetter,
  HeHypothesis,
  HeJob,
  HeOperatorMapping,
  HePersonalizationPlan,
  HeSegmentVariant,
  HeVertical,
} from '../types';
import {
  HeChainCritiqueSchema,
  extractLetterBVariants,
  parsedToChainLetters,
  selectPromptHypotheses,
  type HeChainLetterAB,
} from './chain';
import {
  addUsage,
  newUsage,
  payloadString,
  readProject,
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
 * (тоже нормализуются через normalizeKey). Покрывает канонические переменные
 * Instantly и типичные CSV-базы специалистов (ru/en наименования колонок).
 * Порядок внутри списка важен: первое точное совпадение побеждает.
 */
const OPERATOR_ALIASES: Record<string, string[]> = {
  firstname: ['имя', 'имя лида', 'first name', 'контакт имя'],
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
  city: ['город', 'city', 'area', 'населенный пункт'],
  cityname: ['area', 'city', 'город', 'регион', 'населенный пункт', 'location'],
  region: ['регион', 'region', 'область'],
  country: ['страна', 'country'],
  vacancytitle: ['name', 'вакансия', 'должность', 'название вакансии', 'vacancy', 'position', 'позиция', 'job title'],
  vacancy: ['вакансия', 'название вакансии', 'vacancy', 'должность'],
  industry: ['отрасль', 'индустрия', 'industry', 'ниша'],
  segment: ['сегмент', 'segment'],
};

/**
 * Маппит операторы на колонки базы: точное совпадение (нормализованное),
 * затем таблица синонимов, затем подстрока. Маппинг возможен ТОЛЬКО на колонку
 * из переданного списка. Подстрочные правила ослаблены намеренно: короткие
 * кандидаты (<5 символов) и короткие имена колонок (<5) в подстроке не
 * участвуют — иначе cityName цеплялся бы к колонке «name» (вакансия), а не к
 * «area». Не нашлось — matched=false, column=null (специалист увидит дыру).
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
      if (cand.length < 5) continue;
      const partial = normalizedColumns.find((c) => c.norm.includes(cand));
      if (partial) return { operator, column: partial.column, matched: true };
    }
    for (const cand of candidates) {
      const partial = normalizedColumns.find((c) => c.norm.length >= 5 && cand.includes(c.norm));
      if (partial) return { operator, column: partial.column, matched: true };
    }
    return { operator, column: null, matched: false };
  });
}

/* ───────────────── Pure-часть: сегментные варианты ---SEGMENT: <when>--- ───────────────── */

const LETTER_MARKER_RE = /---\s*LETTER\s*(\d+)\s*---/gi;
const SEGMENT_MARKER_RE = /---\s*SEGMENT\s*:\s*(.+?)\s*---/gi;

export interface SegmentVariantsExtraction {
  /** Текст без блоков вариантов — только основные письма (для letterParser). */
  cleaned: string;
  /** Варианты по 1-based индексу письма (перенумерация как в letterParser). */
  variants: Map<number, HeSegmentVariant[]>;
}

/**
 * Вырезает из сырого ответа модели блоки «---SEGMENT: <when>---», привязывая
 * их к текущему «---LETTER N---». Основной текст писем остаётся дефолтом и
 * парсится letterParser'ом; варианты хранятся отдельно от тела письма.
 */
export function extractSegmentVariants(raw: string): SegmentVariantsExtraction {
  interface Marker {
    kind: 'letter' | 'segment';
    idx: number;
    end: number;
    n?: number;
    when?: string;
  }
  const markers: Marker[] = [];
  for (const m of raw.matchAll(LETTER_MARKER_RE)) {
    markers.push({ kind: 'letter', idx: m.index, end: m.index + m[0].length, n: Number(m[1]) });
  }
  for (const m of raw.matchAll(SEGMENT_MARKER_RE)) {
    markers.push({ kind: 'segment', idx: m.index, end: m.index + m[0].length, when: (m[1] ?? '').trim() });
  }
  markers.sort((a, b) => a.idx - b.idx);
  if (!markers.some((m) => m.kind === 'segment')) return { cleaned: raw, variants: new Map() };

  // Перенумерация как в letterParser: уникальные номера писем по порядку → 1..N.
  const letterNums = [...new Set(markers.filter((m) => m.kind === 'letter').map((m) => m.n!))].sort(
    (a, b) => a - b,
  );
  const reindex = new Map<number, number>(letterNums.map((n, i) => [n, i + 1] as [number, number]));

  const variants = new Map<number, HeSegmentVariant[]>();
  const cutRanges: Array<[number, number]> = [];
  let currentLetter: number | null = null;
  markers.forEach((mk, i) => {
    if (mk.kind === 'letter') {
      currentLetter = mk.n ?? null;
      return;
    }
    const textEnd = i + 1 < markers.length ? markers[i + 1].idx : raw.length;
    const text = raw.slice(mk.end, textEnd).trim();
    cutRanges.push([mk.idx, textEnd]);
    const letterIndex = currentLetter != null ? reindex.get(currentLetter) : undefined;
    if (letterIndex != null && mk.when && text) {
      const list = variants.get(letterIndex) ?? [];
      list.push({ when: mk.when, text });
      variants.set(letterIndex, list);
    }
  });

  let cleaned = raw;
  for (const [start, end] of [...cutRanges].sort((a, b) => b[0] - a[0])) {
    cleaned = cleaned.slice(0, start) + cleaned.slice(end);
  }
  return { cleaned, variants };
}

/**
 * Лёгкая sanity-проверка: условие варианта должно пересекаться с сегментами,
 * названными в анализе базы. Не роняет джобу — только warnings в лог/result.
 */
export function validateSegmentVariants(
  letters: HeChainLetterAB[],
  analysis: HeBaseAnalysisOutput,
): string[] {
  const segmentNames = [
    ...analysis.notable_segments,
    ...analysis.geo_distribution.map((d) => d.value),
    ...analysis.industry_distribution.map((d) => d.value),
    ...analysis.company_type_distribution.map((d) => d.value),
    ...analysis.title_distribution.map((d) => d.value),
  ]
    .map(normalizeKey)
    .filter(Boolean);

  const warnings: string[] = [];
  letters.forEach((l, i) => {
    (l.segment_variants ?? []).forEach((v) => {
      const when = normalizeKey(v.when);
      if (!when) return;
      const overlap = segmentNames.some((n) => when.includes(n) || n.includes(when));
      if (!overlap) {
        warnings.push(`Письмо ${i + 1}: сегмент «${v.when}» не пересекается с сегментами анализа базы`);
      }
    });
  });
  return warnings;
}

/* ───────────────── Pure-часть: валидация operator_mapping ───────────────── */

/**
 * Консистентность operator_mapping:
 *  - matched-колонка обязана быть в списке колонок базы;
 *  - каждый оператор из плана обязан присутствовать в маппинге (mapped или
 *    явно unmatched с fallback);
 *  - unmatched-оператор обязан иметь fallback (иначе подставлять нечего);
 *  - оператор в теме обязан быть matched (fallback в теме невозможен).
 * Возвращает список проблем (пустой — всё чисто).
 */
export function validateOperatorMapping(
  mapping: HeOperatorMapping[],
  columns: string[],
  plan: HeTemplatePlanOutput,
  opts?: { subjectOperators?: string[] },
): string[] {
  const issues: string[] = [];
  const columnKeys = new Set(columns.map(normalizeKey));
  const byOperator = new Map(mapping.map((m) => [m.operator.toLowerCase(), m]));

  for (const m of mapping) {
    if (m.matched && (!m.column || !columnKeys.has(normalizeKey(m.column)))) {
      issues.push(
        `Оператор {{${m.operator}}} замаплен на колонку «${m.column ?? '—'}», которой нет среди колонок базы`,
      );
    }
  }

  for (const lp of plan.personalization_plan ?? []) {
    for (const op of lp.operators ?? []) {
      if (!byOperator.has(op.var.toLowerCase())) {
        issues.push(`Оператор {{${op.var}}} из плана (письмо ${lp.letter_index}) отсутствует в operator_mapping`);
      }
    }
  }

  for (const m of mapping) {
    if (!m.matched && !m.fallback) {
      issues.push(`Оператор {{${m.operator}}} не замаплен на колонку базы и не имеет fallback`);
    }
  }

  for (const op of opts?.subjectOperators ?? []) {
    const m = byOperator.get(op.toLowerCase());
    if (m && !m.matched) {
      issues.push(
        `Оператор {{${m.operator}}} используется в теме письма, но не замаплен на колонку (fallback в теме невозможен)`,
      );
    }
  }

  return issues;
}

/* ───────────────── Pure-часть: длина тел по регламенту ───────────────── */

/** Число слов в тексте (по пробельным токенам; {{var}} считается одним словом). */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Порог, выше которого уходим в retry на сокращение (регламент — ≤80/≤70). */
const SHORTEN_RETRY_WORDS = 85;

/** Предупреждения о длине тел по регламенту (≤80 слов; письмо 1 ≤70). */
export function collectLengthWarnings(letters: HeChainLetterAB[]): string[] {
  const warnings: string[] = [];
  letters.forEach((l, i) => {
    const limit = i === 0 ? 70 : 80;
    const bodyWords = countWords(l.body);
    if (bodyWords > limit) {
      warnings.push(`Письмо ${i + 1}: ${bodyWords} слов в теле (регламент ≤ ${limit})`);
    }
    (l.variants ?? []).forEach((v, vi) => {
      const variantWords = countWords(v.body);
      if (variantWords > limit) {
        warnings.push(
          `Письмо ${i + 1}, вариант ${String.fromCharCode(66 + vi)}: ${variantWords} слов (регламент ≤ ${limit})`,
        );
      }
    });
    (l.segment_variants ?? []).forEach((v) => {
      const variantWords = countWords(v.text);
      if (variantWords > limit) {
        warnings.push(`Письмо ${i + 1}, вариант «${v.when}»: ${variantWords} слов (регламент ≤ ${limit})`);
      }
    });
  });
  return warnings;
}

/* ───────────────── Стадия ───────────────── */

const RETRY_HINT = `Ты вернул слишком мало писем или нарушил формат. Нужно столько же писем, сколько в исходной цепочке (3–5), каждое блоком «---LETTER N---» + строка темы; у письма 1 — вариант B блоком «---LETTER 1 B---»; сегментные варианты — блоками «---SEGMENT: <when>---» после письма. Верни шаблон заново, целиком, без пояснений.`;

function shortenRetryHint(letters: HeChainLetterAB[]): string {
  const counts = letters.map((l, i) => `письмо ${i + 1}: ${countWords(l.body)} слов`).join(', ');
  return (
    `Тела писем длиннее регламента (${counts}). Регламент непреодолим: тело ≤ 80 слов, первое письмо ≤ 70 слов. ` +
    `Сократи каждое длинное письмо, сохранив смысл, операторы {{var}}, блок «---LETTER 1 B---» и блоки «---SEGMENT: <when>---». ` +
    `Верни шаблон заново, целиком, в том же формате.`
  );
}

function operatorIssuesHint(issues: string[]): string {
  return (
    `В шаблоне проблемы с операторами персонализации:\n` +
    issues.map((i) => `- ${i}`).join('\n') +
    `\n\nИсправь: каждый оператор из плана должен реально использоваться в письмах и маппиться на реальную колонку базы; ` +
    `в темах — только операторы с реальной колонкой (fallback в теме невозможен). ` +
    `Верни шаблон заново, целиком, в том же формате (---LETTER N--- / ---SEGMENT: <when>---).`
  );
}

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

  // Разметка специалиста по гипотезам вертикали: rejected уходят из промпта,
  // accepted — первыми (см. selectPromptHypotheses в stages/chain).
  const { data: hyps, error: hError } = await ctx.supabase
    .from('he_hypotheses')
    .select('title, description, tier, status')
    .eq('project_id', job.project_id)
    .eq('vertical_id', base.vertical_id);
  if (hError) throw new Error(`he_hypotheses read: ${hError.message}`);
  const hypSelection = selectPromptHypotheses(
    (hyps ?? []) as Array<Pick<HeHypothesis, 'title' | 'description' | 'tier' | 'status'>>,
  );
  if (hypSelection.fallbackUsed) {
    stageLog(ctx, '[template] все гипотезы вертикали отклонены специалистом — используем полный список без разметки');
  }
  const hypotheses = hypSelection.list.map((h) => ({
    title: h.title,
    description: h.description,
    tier: h.tier,
    confirmed: h.status === 'accepted',
  }));

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

  // Кейс-банк: лучший кейс клиента под вертикаль → главное доказательство
  // fixed_block/писем. Best-effort: сбой чтения he_cases не роняет генерацию.
  let clientCase: HeCase | null = null;
  try {
    clientCase = await selectCaseForVertical(ctx.supabase, job.project_id, {
      name: vertical.name,
      synonyms: vertical.synonyms,
    });
  } catch (e) {
    stageLog(ctx, `[template] кейс-банк недоступен: ${e instanceof Error ? e.message : String(e)} — продолжаем без кейса`);
  }
  if (clientCase) stageLog(ctx, `[template] кейс клиента под вертикаль: ${clientCase.id}`);

  // Стиль клиента из брифа проекта (style_override, рядом с offer_override) →
  // styleExample в промпты плана и финальных писем.
  const project = await readProject(ctx.supabase, job.project_id);
  const brief = (project.brief ?? {}) as Record<string, unknown>;
  const styleExample = typeof brief.style_override === 'string' ? brief.style_override : undefined;

  // Winner-паттерны датасета (best-effort): метки сегментов по терминам
  // вертикали (имя + синонимы), фолбэк хинтов — имя вертикали. Любой сбой →
  // генерим без паттернов, стадию это не валит.
  let winnerPatterns: HeWinnerPattern[] = [];
  try {
    const terms = [vertical.name, ...(Array.isArray(vertical.synonyms) ? vertical.synonyms : [])];
    const labels = matchSegmentLabels(terms);
    winnerPatterns = await getWinnerPatterns(labels.length ? labels : [vertical.name], 5);
  } catch (e) {
    stageLog(ctx, `[template] winner-паттерны датасета недоступны: ${e instanceof Error ? e.message : String(e)}`);
  }

  const columns = Array.isArray(base.columns) ? base.columns : [];

  // Шаг 1: план 85/15.
  const plan = await callLLMWithSchema(
    buildTemplatePlanMessages({
      verticalName: vertical.name,
      verticalSummary: vertical.summary ?? '',
      chainLetters,
      baseAnalysis: analysis,
      columns,
      hypotheses,
      clientCase,
      styleExample,
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
    clientCase,
    styleExample,
    winnerPatterns,
  });

  /** Сырой ответ модели → письма с приклеенными сегментными и B-вариантами. */
  const buildLetters = (raw: string): { parsed: ParsedLetter[]; letters: HeChainLetterAB[] } => {
    // Сначала B-варианты (---LETTER 1 B---), затем сегментные блоки: оба
    // сплиттера работают до letterParser, который про эти маркеры не знает.
    const ab = extractLetterBVariants(raw);
    const seg = extractSegmentVariants(ab.cleaned);
    const parsed = parseLettersFromModelOutput(seg.cleaned);
    const sliced = parsed.slice(0, 6);
    // wait_days — лесенка цепочки CHAIN_WAIT_DAYS (внутри parsedToChainLetters), по индексу письма.
    const letters = parsedToChainLetters(sliced).map((l, i): HeChainLetterAB => {
      const { variants: _legacy, ...rest } = l;
      const idx = sliced[i]?.letter_index ?? i + 1;
      const sv = seg.variants.get(idx);
      const bv = ab.variants.get(idx);
      return {
        ...rest,
        ...(sv?.length ? { segment_variants: sv } : {}),
        ...(bv ? { variants: [bv] } : {}),
      };
    });
    return { parsed, letters };
  };

  let llm = await callLLMText(messages, { model, maxTokens: 6144 });
  addUsage(usage, llm);
  let { parsed, letters } = buildLetters(llm.text);

  if (parsed.length < 3) {
    stageLog(ctx, `[template] распознано ${parsed.length} писем — retry с фидбэком`);
    const retryMessages: LLMMessage[] = [
      ...messages,
      { role: 'assistant', content: llm.text.slice(0, 2000) },
      { role: 'user', content: RETRY_HINT },
    ];
    llm = await callLLMText(retryMessages, { model, maxTokens: 6144 });
    addUsage(usage, llm);
    ({ parsed, letters } = buildLetters(llm.text));
  }
  if (parsed.length < 3) {
    throw new Error(`Шаблон не распарсился: ${parsed.length} писем после retry`);
  }

  // Шаг 2b: длина тел — регламент ≤80 слов (письмо 1 ≤70); >85 слов → один retry на сокращение.
  if (letters.some((l) => countWords(l.body) > SHORTEN_RETRY_WORDS)) {
    stageLog(ctx, '[template] тела писем длиннее регламента — retry на сокращение');
    const retryLlm = await callLLMText(
      [
        ...messages,
        { role: 'assistant', content: llm.text.slice(0, 2000) },
        { role: 'user', content: shortenRetryHint(letters) },
      ],
      { model, maxTokens: 6144 },
    );
    addUsage(usage, retryLlm);
    const rebuilt = buildLetters(retryLlm.text);
    if (rebuilt.parsed.length >= 3) {
      llm = retryLlm;
      ({ parsed, letters } = rebuilt);
    } else {
      stageLog(ctx, '[template] сокращённый вариант не распарсился — оставляем исходные письма');
    }
  }

  // Шаг 2c: критик-луп — одна оценка финальных писем той же моделью, что и
  // генерация (getHeModel('chain')), + максимум один rewrite по её замечаниям.
  // Критик работает ТОЛЬКО по основному варианту A (B-вариант и сегментные
  // варианты в разбор не идут — стоимость). Rewrite не содержит ---SEGMENT---
  // и ---LETTER N B--- блоков: варианты после его принятия восстанавливаются
  // из исходных писем по индексу. Без цикла; сбой критика, нечитаемый,
  // урезанный или раздутый rewrite → остаются исходные письма. Операторы
  // (шаг 3) считаются уже по финальному тексту.
  let critiqueInfo: { verdict: string; issues_count: number; rewritten: boolean } | null = null;
  try {
    const criticLetters = letters.map((l) => ({ subject: l.subject ?? '', body: l.body }));
    const critique = await callLLMWithSchema(
      buildTemplateCriticMessages({
        verticalName: vertical.name,
        verticalSummary: vertical.summary ?? '',
        letters: criticLetters,
        language,
        styleExample,
        winnerPatterns,
      }),
      HeChainCritiqueSchema,
      { model, maxTokens: 2048 },
    );
    addUsage(usage, critique);
    // letter_index вне 1..letters.length — галлюцинация критика: отбрасываем
    // такие issue до решения о рерайте, чтобы не переписывать по фантомам.
    const issues = critique.data.issues.filter(
      (i) => i.letter_index >= 1 && i.letter_index <= letters.length,
    );
    critiqueInfo = { verdict: critique.data.verdict, issues_count: issues.length, rewritten: false };

    if (issues.length > 0) {
      const rewrite = await callLLMText(
        buildTemplateRewriteMessages({
          verticalName: vertical.name,
          letters: criticLetters,
          critique: { ...critique.data, issues },
          language,
          styleExample,
          winnerPatterns,
        }),
        { model, maxTokens: 6144 },
      );
      addUsage(usage, rewrite);
      const rebuilt = buildLetters(rewrite.text);
      // Принимаем rewrite только при точном совпадении числа писем: иначе
      // ломаются лесенка wait_days и индексация сегментных вариантов.
      if (rebuilt.parsed.length === letters.length) {
        llm = rewrite;
        parsed = rebuilt.parsed;
        // Рерайт выводит только тему+тело основного варианта (---SEGMENT--- и
        // ---LETTER N B--- блоков в нём нет): варианты восстанавливаем
        // детерминированно из исходных писем по индексу.
        const originalLetters = letters;
        letters = rebuilt.letters.map((l, i): HeChainLetterAB => {
          const orig = originalLetters[i];
          return {
            ...l,
            ...(orig?.segment_variants?.length ? { segment_variants: orig.segment_variants } : {}),
            ...(orig?.variants?.length ? { variants: orig.variants } : {}),
          };
        });
        critiqueInfo.rewritten = true;
      } else {
        stageLog(ctx, `[template] rewrite критика: ${rebuilt.parsed.length} писем вместо ${letters.length} — оставляем исходные`);
      }
    }
  } catch (e) {
    stageLog(ctx, `[template] критик-луп недоступен: ${e instanceof Error ? e.message : String(e)} — оставляем исходные письма`);
  }

  // Шаг 3: операторы финальных писем → колонки базы (pure) + консистентность.
  // Операторы собираются из основного текста (A), B-вариантов и сегментных
  // вариантов: B — полноценное письмо и тоже может нести {{var}}.
  const collectOperators = (ls: HeChainLetterAB[]) => {
    const variantTexts = (l: HeChainLetterAB) => (l.variants ?? []).flatMap((v) => [v.subject ?? '', v.body]);
    const subjectOperators = extractPersonalizationOperators(
      ls.map((l) => [l.subject ?? '', ...variantTexts(l)].join('\n')).join('\n'),
    );
    const allOperators = extractPersonalizationOperators(
      ls
        .map((l) =>
          [
            l.subject ?? '',
            l.body,
            ...variantTexts(l),
            ...(l.segment_variants ?? []).map((v) => v.text),
          ].join('\n'),
        )
        .join('\n'),
    );
    return { subjectOperators, allOperators };
  };

  // Операторы плана обязаны попасть в маппинг: отсутствующие в финальных
  // письмах добавляем явно unmatched (с fallback из плана) — дыра видна специалисту.
  const buildMapping = (ops: string[]): HeOperatorMapping[] => {
    const mapped = mapOperatorsToColumns(ops, columns);
    const present = new Set(mapped.map((m) => m.operator.toLowerCase()));
    const fallbackByVar = new Map<string, string>();
    for (const lp of plan.data.personalization_plan) {
      for (const op of lp.operators) {
        const key = op.var.toLowerCase();
        if (op.fallback && !fallbackByVar.has(key)) fallbackByVar.set(key, op.fallback);
        if (!present.has(key)) {
          mapped.push({
            operator: op.var,
            column: null,
            matched: false,
            ...(op.fallback ? { fallback: op.fallback } : {}),
          });
          present.add(key);
        }
      }
    }
    return mapped.map((m) =>
      !m.matched && !m.fallback && fallbackByVar.has(m.operator.toLowerCase())
        ? { ...m, fallback: fallbackByVar.get(m.operator.toLowerCase()) }
        : m,
    );
  };

  let ops = collectOperators(letters);
  let operatorMapping = buildMapping(ops.allOperators);
  let mappingIssues = validateOperatorMapping(operatorMapping, columns, plan.data, {
    subjectOperators: ops.subjectOperators,
  });

  if (mappingIssues.length) {
    stageLog(ctx, `[template] operator_mapping: ${mappingIssues.length} проблем — retry с фидбэком`);
    const retryLlm = await callLLMText(
      [
        ...messages,
        { role: 'assistant', content: llm.text.slice(0, 2000) },
        { role: 'user', content: operatorIssuesHint(mappingIssues) },
      ],
      { model, maxTokens: 6144 },
    );
    addUsage(usage, retryLlm);
    const rebuilt = buildLetters(retryLlm.text);
    if (rebuilt.parsed.length >= 3) {
      llm = retryLlm;
      letters = rebuilt.letters;
      ops = collectOperators(letters);
      operatorMapping = buildMapping(ops.allOperators);
      mappingIssues = validateOperatorMapping(operatorMapping, columns, plan.data, {
        subjectOperators: ops.subjectOperators,
      });
    } else {
      stageLog(ctx, '[template] retry по операторам не распарсился — оставляем предыдущие письма');
    }
  }
  if (mappingIssues.length) {
    stageLog(ctx, `[template] operator_mapping issues (best effort): ${mappingIssues.join(' | ')}`);
  }

  const segmentWarnings = validateSegmentVariants(letters, analysis);
  if (segmentWarnings.length) stageLog(ctx, `[template] segment_warnings: ${segmentWarnings.join(' | ')}`);
  const lengthWarnings = collectLengthWarnings(letters);
  if (lengthWarnings.length) stageLog(ctx, `[template] length_warnings: ${lengthWarnings.join(' | ')}`);

  const personalizationPlan: HePersonalizationPlan = {
    letters: plan.data.personalization_plan,
    additions: plan.data.segment_additions,
    segment_variants: plan.data.letters,
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
      llm_model: model,
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
      length_warnings: lengthWarnings,
      operator_mapping_issues: mappingIssues,
      segment_warnings: segmentWarnings,
      critique: critiqueInfo,
    },
    tokensUsed: usage.tokensUsed,
    costUsd: usage.costUsd,
  };
}
