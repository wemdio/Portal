/** Direct final emails from the client, hypothesis and analysed audience. No paid draft chain or textual plan. */
import { z } from 'zod';
import { callLLMWithSchema, getVeModel } from '../llm';
import { VeBaseAnalysisSchema, type VeBaseAnalysisOutput, type VeTemplatePlanOutput } from '../schemas';
import { buildVeFinalLetterMessages } from '../prompts/finalLetters';
import { buildVeFinalPersonalization, normalizeVeFinalLetters } from '../finalLetters';
import { applyVeChainTiming } from '../chainTiming';
import { compileClientBriefForLetters, splitBriefForLetterPrompt } from '../clientBriefIntake';
import { selectCaseForVertical } from '../caseBank';
import { extractNumberFacts, findUnverifiedNumbers } from '../letterChecks';
import type { VeBase, VeChainLanguage, VeChainLetter, VeJob, VeOperatorMapping, VeSegmentVariant, VeTemplate, VeVertical } from '../types';
import type { VeChainLetterAB } from './chain';
import { addUsage, newUsage, payloadString, readProject, type VeStageContext, type VeStageResult } from './shared';

/* ───────────────── Pure-часть: операторы персонализации ───────────────── */

export { extractPersonalizationOperators, mapOperatorsToColumns } from '../letterPersonalization';

function normalizeKey(value: string): string { return value.toLowerCase().replace(/[{}]/g, '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim(); }

/* ───────────────── Pure-часть: сегментные варианты ---SEGMENT: <when>--- ───────────────── */

const LETTER_MARKER_RE = /---\s*LETTER\s*(\d+)\s*---/gi;
const SEGMENT_MARKER_RE = /---\s*SEGMENT\s*:\s*(.+?)\s*---/gi;

export interface SegmentVariantsExtraction {
  /** Текст без блоков вариантов — только основные письма (для letterParser). */
  cleaned: string;
  /** Варианты по 1-based индексу письма (перенумерация как в letterParser). */
  variants: Map<number, VeSegmentVariant[]>;
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

  const variants = new Map<number, VeSegmentVariant[]>();
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
  letters: VeChainLetterAB[],
  analysis: VeBaseAnalysisOutput,
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
  mapping: VeOperatorMapping[],
  columns: string[],
  plan: VeTemplatePlanOutput,
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
/** Предупреждения о длине тел по регламенту (≤80 слов; письмо 1 ≤70). */
export function collectLengthWarnings(letters: VeChainLetterAB[]): string[] {
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

const normalizedWords = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

export async function runTemplateStage(job: VeJob, ctx: VeStageContext): Promise<VeStageResult> {
  const usage = newUsage();
  const baseId = payloadString(job, 'base_id');
  const { data: baseRow, error: baseError } = await ctx.supabase.from('ve_bases').select('*').eq('id', baseId).eq('project_id', job.project_id).single();
  if (baseError || !baseRow) throw new Error(`База недоступна: ${baseError?.message ?? 'not found'}`);
  const base = baseRow as VeBase;
  const { data: existing, error: existingError } = await ctx.supabase.from('ve_templates').select('*').eq('base_id', baseId).eq('status', 'ready').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (existingError) throw new Error(`Не удалось проверить сохранённые письма: ${existingError.message}`);
  if (existing) {
    const saved = existing as VeTemplate;
    return { result: { template_id: saved.id, letters: saved.letters, personalization_plan: saved.personalization_plan, reused: true }, tokensUsed: 0, costUsd: 0 };
  }
  const analysis = VeBaseAnalysisSchema.parse(base.analysis);
  const { data: verticalRow, error: verticalError } = await ctx.supabase.from('ve_verticals').select('*').eq('id', base.vertical_id).eq('project_id', job.project_id).single();
  if (verticalError || !verticalRow) throw new Error(`Вертикаль недоступна: ${verticalError?.message ?? 'not found'}`);
  const vertical = verticalRow as VeVertical;
  let query = ctx.supabase.from('ve_hypotheses').select('title, description, fit_rationale, evidence, status').eq('project_id', job.project_id).eq('vertical_id', base.vertical_id);
  query = base.hypothesis_id ? query.eq('id', base.hypothesis_id) : query.neq('status', 'rejected');
  const { data: hypotheses, error: hypothesisError } = await query;
  if (hypothesisError || !hypotheses?.length) throw new Error('Не найдена гипотеза для финальных писем.');
  const project = await readProject(ctx.supabase, job.project_id);
  const brief = project.brief ?? {};
  // Migration-only settings reuse: an old draft is optional, never generated or used as letter content.
  const { data: legacyChain, error: timingError } = await ctx.supabase.from('ve_chains').select('letters, language').eq('vertical_id', base.vertical_id).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (timingError) throw new Error(`Не удалось проверить сохранённые интервалы: ${timingError.message}`);
  const savedTiming = Array.isArray(legacyChain?.letters) ? legacyChain.letters as Array<{ wait_days?: number }> : [];
  const languageValue = job.payload.language ?? (brief as Record<string, unknown>).language ?? legacyChain?.language;
  const language: VeChainLanguage = languageValue === 'en' || languageValue === 'pl' ? languageValue : 'ru';
  const requestedCount = job.payload.letter_count;
  const letterCount = typeof requestedCount === 'number' && Number.isInteger(requestedCount) && requestedCount >= 3 && requestedCount <= 6 ? requestedCount : savedTiming.length >= 3 && savedTiming.length <= 6 ? savedTiming.length : 3;
  let clientCase: Awaited<ReturnType<typeof selectCaseForVertical>> = null;
  try { clientCase = await selectCaseForVertical(ctx.supabase, job.project_id, { name: vertical.name, synonyms: vertical.synonyms }); } catch { /* A missing optional case never authorises inventing one. */ }
  const columns = Array.isArray(base.columns) ? base.columns : [];
  const promptBrief = splitBriefForLetterPrompt(brief);
  const input = { language, letterCount, client: { name: project.name, website_url: project.website_url,
    research: promptBrief.briefJson, client_brief: compileClientBriefForLetters(promptBrief.clientBrief),
    offer: brief.offer_override, style: brief.style_override, sender_signature: brief.signature_override },
    vertical: { name: vertical.name, summary: vertical.summary }, hypotheses, baseAnalysis: analysis, columns, clientCase };
  const facts = extractNumberFacts(JSON.stringify(input));
  const bodySchema = z.object({ body: z.string().min(1).max(12000), angle: z.string().min(1).max(1000),
    cta_intent: z.enum(['check_relevance', 'identify_owner', 'choose_priority', 'confirm_timing']) });
  const schema = z.object({ subject_options: z.array(z.string().min(1).max(500)).length(6),
    letters: z.array(z.object({ a: bodySchema, b: bodySchema })).length(letterCount) }).superRefine((output, ctx) => {
    if (new Set(output.subject_options.map(normalizedWords)).size !== 6) ctx.addIssue({ code: 'custom', message: 'All six subjects must be distinct.', path: ['subject_options'] });
    output.letters.forEach((letter, index) => {
      if (normalizedWords(letter.a.body) === normalizedWords(letter.b.body) || normalizedWords(letter.a.angle) === normalizedWords(letter.b.angle) || letter.a.cta_intent === letter.b.cta_intent) ctx.addIssue({ code: 'custom', path: ['letters', index], message: 'A and B need distinct bodies, angles and CTA intents.' });
      for (const side of ['a', 'b'] as const) {
        const body = letter[side].body;
        if (countWords(body) > (index === 0 ? 70 : 80) || (body.match(/\?/g) ?? []).length !== 1 || /[—–]/.test(body)) ctx.addIssue({ code: 'custom', path: ['letters', index, side], message: 'Respect the word limit, exactly one question, and no em/en dashes.' });
        if (findUnverifiedNumbers(body, facts).length) ctx.addIssue({ code: 'custom', path: ['letters', index, side], message: 'Remove numerical facts not found in the supplied material.' });
      }
    });
    const candidate = toLetters(output);
    const normalized = normalizeVeFinalLetters(candidate);
    if (normalized.error) ctx.addIssue({ code: 'custom', message: normalized.error });
    else try { buildVeFinalPersonalization(normalized.letters!, columns); } catch (error) { ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid personalization' }); }
  });
  function toLetters(output: { subject_options: string[]; letters: Array<{ a: { body: string; angle: string; cta_intent: string }; b: { body: string; angle: string; cta_intent: string } }> }): VeChainLetter[] {
    return applyVeChainTiming(output.letters.map((letter, index): VeChainLetter => ({ subject: index === 0 ? output.subject_options[0] : null,
      ...letter.a, variants: [{ subject: null, ...letter.b }], selected_variant: 'A', wait_days: 0,
      ...(index === 0 ? { subject_options: output.subject_options, selected_subject_indices: [0] } : {}) })), savedTiming);
  }
  const model = getVeModel('chain');
  const output = await callLLMWithSchema(buildVeFinalLetterMessages(input), schema, { model, maxTokens: 10000 });
  addUsage(usage, output);
  const letters = normalizeVeFinalLetters(toLetters(output.data)).letters!;
  const personalizationPlan = buildVeFinalPersonalization(letters, columns);
  const { data: inserted, error: insertError } = await ctx.supabase.from('ve_templates').insert({
    base_id: baseId, vertical_id: base.vertical_id, fixed_block: '', personalization_plan: personalizationPlan,
    letters, status: 'ready', llm_model: model, tokens_used: usage.tokensUsed, cost_usd: usage.costUsd,
  }).select('id').single();
  if (insertError || !inserted) throw new Error(`Не удалось сохранить финальные письма: ${insertError?.message ?? 'unknown'}`);
  return { result: { template_id: inserted.id, letters, personalization_plan: personalizationPlan, direct_final: true }, tokensUsed: usage.tokensUsed, costUsd: usage.costUsd };
}

/* ───────────────── Стадия ───────────────── */
