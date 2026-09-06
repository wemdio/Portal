/**
 * Стадия chain: вертикаль + бриф проекта → цепочка из 3–5 писем.
 * Промпт-архитектура emailSequenceV2 (материалы → праймер → задача) +
 * CHAIN_REGULATIONS; ответ парсится маркерами ---LETTER N--- через
 * letterParser, A/B-варианты (---LETTER N B---, у каждого письма второй
 * повод/угол) вырезаются пост-сплиттером extractLetterBVariants ДО
 * letterParser (он общий с emailSequenceV2 и не знает про B-маркеры).
 * Языки: ru/en/pl (job.payload.language).
 * Разметка специалиста (ve_hypotheses.status) учитывается через
 * selectPromptHypotheses: rejected исключаются, accepted — первыми.
 * В промпт подмешиваются style_override из брифа (styleExample),
 * signature_override (дословная подпись отправителя) и winner-паттерны
 * датасета (best-effort). Перед критиком — детерминированный контроль
 * (letterChecks): тире/приветствие/один CTA/стоп-фразы + числа только из
 * материалов; нарушения чинятся одним фикс-проходом. После — критик-луп:
 * одна оценка цепочки (только основной вариант A) + максимум один rewrite
 * по её замечаниям; B-варианты после рерайта восстанавливаются из исходных.
 */

import { z } from 'zod';

import { parseLettersFromModelOutput, type ParsedLetter } from '@/lib/emailSequenceV2/letterParser';
import { applyVeChainTiming, VE_CHAIN_DEFAULT_WAIT_DAYS } from '../chainTiming';
import { callLLMText, callLLMTextWithFallback, callLLMWithSchema, getVeModel, type LLMMessage } from '../llm';
import { buildChainCriticMessages, buildChainMessages, buildChainRewriteMessages, buildChainRuleFixHint } from '../prompts/chain';
import { checkLetterRules, extractNumberFacts, type VeLetterForCheck } from '../letterChecks';
import { compileClientBriefForLetters, splitBriefForLetterPrompt } from '../clientBriefIntake';
import { getWinnerPatterns, matchSegmentLabels, type VeWinnerPattern } from '../datasetStats';
import { selectCaseForVertical, type VeCase } from '../caseBank';
import type { VeChainLanguage, VeChainLetter, VeEvidenceItem, VeHypothesis, VeJob, VeVertical } from '../types';
import {
  addUsage,
  newUsage,
  payloadString,
  readProject,
  stageLog,
  type VeStageContext,
  type VeStageResult,
} from './shared';

/** Паузы в днях после предыдущего письма по индексу письма (0-based). */
export const CHAIN_WAIT_DAYS = VE_CHAIN_DEFAULT_WAIT_DAYS;

/** ParsedLetter[] letterParser → VeChainLetter[] с лесенкой wait_days. */
export function parsedToChainLetters(parsed: ParsedLetter[]): VeChainLetter[] {
  return applyVeChainTiming(parsed.map((l) => ({
    subject: l.subject,
    body: l.body,
  })));
}

/* ───────────────── A/B-варианты писем (---LETTER N B---) ───────────────── */

/** A/B-вариант письма: тема+тело альтернативного повода/угла (A — основной subject/body). */
export interface VeChainLetterVariant {
  subject: string | null;
  body: string;
}

/**
 * Письмо цепочки с A/B-вариантом: variants хранит объект {subject, body}
 * варианта B (вариант A — само письмо). В types.ts поле VeChainLetter.variants
 * объявлено как legacy string[] и не используется; фактический jsonb-контракт
 * ve_chains/ve_templates фиксируем здесь (types.ts вне скоупа итерации).
 */
export type VeChainLetterAB = Omit<VeChainLetter, 'variants'> & {
  variants?: VeChainLetterVariant[];
};

/** Маркер варианта B: ---LETTER 2 B--- (регистр и пробелы толерантны). */
const LETTER_B_MARKER_RE = /---\s*LETTER\s*(\d+)\s*B\s*---/gi;

export interface LetterBExtraction {
  /** Текст без B-блоков — только основные письма (для letterParser). */
  cleaned: string;
  /** Вариант B по 1-based индексу письма (перенумерация как в letterParser). */
  variants: Map<number, VeChainLetterVariant>;
}

/**
 * Пост-сплиттер A/B-вариантов: вырезает блоки «---LETTER N B---» из сырого
 * ответа модели и возвращает их отдельно от основных писем. letterParser
 * (общий с emailSequenceV2, его не меняем) про B-маркеры не знает и склеил бы
 * B-блок в тело основного письма, поэтому сплит работает ДО него. Тема/тело
 * варианта парсятся тем же letterParser'ом (fallback-ветка по локализованному
 * слову темы: Тема:/Subject:/Temat:). B для несуществующего письма и дубли
 * отбрасываются.
 */
export function extractLetterBVariants(raw: string): LetterBExtraction {
  const bMarkers: Array<{ idx: number; end: number; n: number }> = [];
  for (const m of raw.matchAll(LETTER_B_MARKER_RE)) {
    bMarkers.push({ idx: m.index, end: m.index + m[0].length, n: Number(m[1]) });
  }
  if (!bMarkers.length) return { cleaned: raw, variants: new Map() };

  // Перенумерация как в letterParser: уникальные номера основных писем → 1..N.
  const letterNums = [
    ...new Set([...raw.matchAll(/---\s*LETTER\s*(\d+)\s*---/gi)].map((m) => Number(m[1]))),
  ].sort((a, b) => a - b);

  // Деградация: основных маркеров ---LETTER N--- нет вообще — модель пометила
  // ВСЕ блоки как B (случай из прода: вырезание давало пустой текст и
  // «0 писем после retry»). Тогда трактуем B-маркеры как основные письма:
  // меняем их на ---LETTER N--- и парсим дальше как обычную цепочку.
  if (letterNums.length === 0) {
    return {
      cleaned: raw.replace(/---\s*LETTER\s*(\d+)\s*B\s*---/gi, '---LETTER $1---'),
      variants: new Map(),
    };
  }

  const reindex = new Map<number, number>(letterNums.map((n, i) => [n, i + 1] as [number, number]));

  const variants = new Map<number, VeChainLetterVariant>();
  const cutRanges: Array<[number, number]> = [];
  for (const bm of bMarkers) {
    // Конец B-блока — ближайший следующий маркер любого типа (LETTER/LETTER B/SEGMENT).
    const anyMarker = /---\s*LETTER\s*\d+\s*(?:B\s*)?---|---\s*SEGMENT\s*:\s*.+?---/gi;
    anyMarker.lastIndex = bm.end;
    const next = anyMarker.exec(raw);
    const textEnd = next ? next.index : raw.length;
    cutRanges.push([bm.idx, textEnd]);
    const letterIndex = reindex.get(bm.n);
    if (letterIndex == null || variants.has(letterIndex)) continue;
    const first = parseLettersFromModelOutput(raw.slice(bm.end, textEnd).trim())[0];
    if (first && (first.subject || first.body.trim())) {
      variants.set(letterIndex, { subject: first.subject, body: first.body });
    }
  }

  let cleaned = raw;
  for (const [start, end] of [...cutRanges].sort((a, b) => b[0] - a[0])) {
    cleaned = cleaned.slice(0, start) + cleaned.slice(end);
  }
  return { cleaned, variants };
}

/**
 * Сырой ответ модели → основные письма (letterParser) с приклеенными
 * B-вариантами. Вариант A — основной subject/body письма; variants[0] — B.
 */
export function buildChainLetters(raw: string): { parsed: ParsedLetter[]; letters: VeChainLetterAB[] } {
  const ab = extractLetterBVariants(raw);
  const parsed = parseLettersFromModelOutput(ab.cleaned);
  const sliced = parsed.slice(0, 6);
  const letters = parsedToChainLetters(sliced).map((l, i): VeChainLetterAB => {
    const { variants: _legacy, ...rest } = l;
    const bv = ab.variants.get(sliced[i]?.letter_index ?? i + 1);
    return bv ? { ...rest, variants: [bv] } : rest;
  });
  return { parsed, letters };
}

/**
 * Разметка специалиста (ve_hypotheses.status: proposed/accepted/rejected) →
 * список гипотез для промпта генерационных стадий (chain/vocab/template):
 *  - status='rejected' исключается из входа целиком;
 *  - status='accepted' идут первыми (порядок внутри групп — как во входном
 *    массиве, т.е. у chain по potential_pct desc; сортировка стабильная);
 *  - если ВСЕ гипотезы вертикали отклонены — откат к полному списку без
 *    разметки (fallbackUsed=true, стадия пишет заметку в лог): генерация не
 *    должна идти на пустом входе;
 *  - строк без status (legacy) считаем proposed; пустой вход → пустой список
 *    (поведение legacy-проектов без гипотез не меняется).
 */
export interface PromptHypothesesSelection<T> {
  list: T[];
  /** true — все гипотезы отклонены, вернули полный список как есть. */
  fallbackUsed: boolean;
}

export function selectPromptHypotheses<T extends { status?: string | null }>(
  rows: T[],
): PromptHypothesesSelection<T> {
  if (!rows.length) return { list: [], fallbackUsed: false };
  const usable = rows.filter((r) => r.status !== 'rejected');
  if (!usable.length) return { list: rows, fallbackUsed: true };
  const rank = (r: T) => (r.status === 'accepted' ? 0 : 1);
  return { list: [...usable].sort((a, b) => rank(a) - rank(b)), fallbackUsed: false };
}

/**
 * Zod-схема ответа критика цепочки — зеркало контракта VeChainCritique из
 * prompts/chain (вердикт + проблемы с фиксами по индексам писем). Локальная
 * для стадий (в schemas.ts не выносим); template-стадия переиспользует её же.
 */
export const VeChainCritiqueSchema = z.object({
  verdict: z.string(),
  issues: z
    .array(
      z.object({
        letter_index: z.number().int(),
        problem: z.string(),
        fix: z.string(),
      }),
    )
    .default([]),
});

const RETRY_HINT = `Ты вернул слишком мало писем или нарушил формат. Нужно 3–5 писем, каждое блоком «---LETTER N---» + строка темы, плюс вариант B каждого письма блоком «---LETTER N B---» сразу после него. Верни цепочку заново, целиком, без пояснений.`;

export async function runChainStage(job: VeJob, ctx: VeStageContext): Promise<VeStageResult> {
  const usage = newUsage();
  const verticalId = payloadString(job, 'vertical_id');
  const language = (typeof job.payload?.language === 'string' ? job.payload.language : 'ru') as VeChainLanguage;

  const { data: verticalRow, error: vError } = await ctx.supabase
    .from('ve_verticals')
    .select('*')
    .eq('id', verticalId)
    .single();
  if (vError || !verticalRow) throw new Error(`ve_verticals ${verticalId}: ${vError?.message ?? 'not found'}`);
  const vertical = verticalRow as VeVertical;

  const project = await readProject(ctx.supabase, job.project_id);

  const { data: hyps, error: hError } = await ctx.supabase
    .from('ve_hypotheses')
    .select('*')
    .eq('project_id', job.project_id)
    .eq('vertical_id', verticalId)
    .order('potential_pct', { ascending: false });
  if (hError) throw new Error(`ve_hypotheses read: ${hError.message}`);
  // Разметка специалиста: rejected уходят из промпта, accepted — первыми.
  const selection = selectPromptHypotheses((hyps ?? []) as VeHypothesis[]);
  if (selection.fallbackUsed) {
    stageLog(ctx, '[chain] все гипотезы вертикали отклонены специалистом — используем полный список без разметки');
  }
  const hypotheses = selection.list;

  const brief = (project.brief ?? {}) as Record<string, unknown>;
  // style_override/offer_override/signature_override и бриф клиента попадают в
  // промпт отдельными блоками (styleExample / offerOverride /
  // signatureOverride / clientBrief) — из JSON-снапшота их вырезаем, чтобы не
  // дублировать длинные тексты в материалах.
  const { briefJson: briefRest, clientBrief: clientBriefRecord } = splitBriefForLetterPrompt(brief);
  // Ответы клиента — читаемым блоком: УТП, гарантии и акцию письма берут
  // дословно, из сырого JSON так не получалось.
  const clientBriefText = compileClientBriefForLetters(clientBriefRecord);

  // Кейс-банк: лучший кейс клиента под вертикаль → главное доказательство
  // цепочки. Best-effort: сбой чтения ve_cases не роняет генерацию.
  let clientCase: VeCase | null = null;
  try {
    clientCase = await selectCaseForVertical(ctx.supabase, job.project_id, {
      name: vertical.name,
      synonyms: vertical.synonyms,
    });
  } catch (e) {
    stageLog(ctx, `[chain] кейс-банк недоступен: ${e instanceof Error ? e.message : String(e)} — продолжаем без кейса`);
  }
  if (clientCase) stageLog(ctx, `[chain] кейс клиента под вертикаль: ${clientCase.id}`);

  // Стиль клиента из брифа (style_override, рядом с offer_override) →
  // styleExample в промпт генерации.
  const styleExample = typeof brief.style_override === 'string' ? brief.style_override : undefined;

  // Подпись отправителя из брифа (signature_override) → signatureOverride в
  // промпты генерации и рерайта (рерайт иначе может «снять» подпись).
  const signatureOverride =
    typeof brief.signature_override === 'string' ? brief.signature_override : undefined;

  // Winner-паттерны датасета (best-effort): метки сегментов по терминам
  // вертикали (имя + синонимы), фолбэк хинтов — имя вертикали. Любой сбой →
  // генерим без паттернов, стадию это не валит.
  let winnerPatterns: VeWinnerPattern[] = [];
  try {
    const terms = [vertical.name, ...(Array.isArray(vertical.synonyms) ? vertical.synonyms : [])];
    const labels = matchSegmentLabels(terms);
    winnerPatterns = await getWinnerPatterns(labels.length ? labels : [vertical.name], 5);
  } catch (e) {
    stageLog(ctx, `[chain] winner-паттерны датасета недоступны: ${e instanceof Error ? e.message : String(e)}`);
  }

  const messages = buildChainMessages({
    language,
    verticalName: vertical.name,
    verticalSummary: vertical.summary ?? '',
    synonyms: Array.isArray(vertical.synonyms) ? vertical.synonyms : [],
    hypotheses: hypotheses.map((h) => ({
      title: h.title,
      description: h.description,
      potential_pct: h.potential_pct,
      tier: h.tier,
      confirmed: h.status === 'accepted',
      evidence: (Array.isArray(h.evidence) ? h.evidence : []) as VeEvidenceItem[],
    })),
    briefText: JSON.stringify(briefRest),
    clientBrief: clientBriefText,
    offerOverride: typeof brief.offer_override === 'string' ? brief.offer_override : undefined,
    operatorsHint: typeof job.payload?.operators_hint === 'string' ? job.payload.operators_hint : undefined,
    clientCase,
    styleExample,
    winnerPatterns,
    signatureOverride,
  });

  const model = getVeModel('chain');
  let llm = await callLLMTextWithFallback(messages, { model, maxTokens: 16384, log: (m) => stageLog(ctx, m) });
  addUsage(usage, llm);
  let { parsed, letters } = buildChainLetters(llm.text);

  if (parsed.length < 3) {
    stageLog(ctx, `[chain] распознано ${parsed.length} писем — retry с фидбэком`);
    const retryMessages: LLMMessage[] = [
      ...messages,
      { role: 'assistant', content: llm.text.slice(0, 2000) },
      { role: 'user', content: RETRY_HINT },
    ];
    llm = await callLLMTextWithFallback(retryMessages, { model, maxTokens: 16384, log: (m) => stageLog(ctx, m) });
    addUsage(usage, llm);
    ({ parsed, letters } = buildChainLetters(llm.text));
  }
  if (parsed.length < 3) {
    // Диагностика в ошибку (пишется в ve_jobs.error): начало сырого ответа,
    // чтобы по проду было видно формат без реплея. Отдельно размечаем отказ
    // по контентной политике (регулируемые ниши: крипто, финансы и т.п.).
    const debug = llm.text.replace(/\s+/g, ' ').slice(0, 300);
    const refusal = llm.finishReason === 'content_filter' || llm.text.length < 20
      ? ` Модель, похоже, отклонила генерацию по контентной политике (finish=${llm.finishReason ?? 'n/a'}): чувствительная ниша клиента — попробуйте переписать оффер/бриф нейтральнее или другую модель (VE_MODEL_CHAIN/VE_MODEL_CHAIN_FALLBACK).`
      : '';
    throw new Error(`Цепочка не распарсилась: ${parsed.length} писем после retry.${refusal} Ответ модели: ${debug}`);
  }

  // ── Детерминированный контроль регламента + фактчек цифр (letterChecks) ──
  // Что машина проверяет надёжнее модели: тире, приветствие, ровно один CTA,
  // стоп-фразы; числа с %/многозначные/десятичные — только из материалов.
  // Нарушения → один фикс-проход со списком проблем ДО критика (критик
  // ревьюит смысл, а не механику). Проверяются оба варианта (A и B) — B несёт
  // «самую острую цифру», его фактчек важнее всего.
  const factCorpus = [
    hypotheses
      .map((h) =>
        [
          h.title,
          h.description ?? '',
          ...((Array.isArray(h.evidence) ? h.evidence : []) as VeEvidenceItem[]).map(
            (e) => `${e.claim} ${e.quote}`,
          ),
        ].join('\n'),
      )
      .join('\n'),
    // Вертикаль, кейс, стиль и ПОДПИСЬ — санкционированные источники: подпись
    // идёт в письма дословно (её телефон/цифры не должны флагаться фактчеком).
    vertical.name,
    vertical.summary ?? '',
    clientCase ? JSON.stringify(clientCase) : '',
    JSON.stringify(briefRest),
    // Цифры клиента из брифа (сроки отсрочки, скидки, годы на рынке) —
    // санкционированные факты: без этой строки фактчек пометил бы их как
    // выдуманные, ведь из JSON-снапшота бриф теперь вырезан.
    clientBriefText,
    typeof brief.offer_override === 'string' ? brief.offer_override : '',
    styleExample ?? '',
    signatureOverride ?? '',
    JSON.stringify(winnerPatterns),
  ].join('\n');
  const facts = extractNumberFacts(factCorpus);
  const lettersForCheck = (ls: VeChainLetterAB[]): VeLetterForCheck[] =>
    ls.flatMap((l) => [
      { subject: l.subject ?? '', body: l.body, variant: 'A' },
      ...(l.variants ?? []).map((v) => ({ subject: v.subject ?? '', body: v.body, variant: 'B' })),
    ]);
  const ruleViolations = checkLetterRules(lettersForCheck(letters), language, facts);
  if (ruleViolations.length > 0) {
    stageLog(ctx, `[chain] детерминированный контроль: ${ruleViolations.length} нарушений — фикс-проход`);
    // Принятие фикса: то же число писем и НЕ меньше B-вариантов (модель могла
    // молча выкинуть блоки ---LETTER N B--- — принять такое нельзя).
    const countB = (ls: VeChainLetterAB[]) => ls.reduce((acc, l) => acc + (l.variants?.length ?? 0), 0);
    try {
      const fixMessages: LLMMessage[] = [
        ...messages,
        { role: 'assistant', content: llm.text },
        { role: 'user', content: buildChainRuleFixHint(ruleViolations, language) },
      ];
      const fix = await callLLMText(fixMessages, { model, maxTokens: 16384 });
      addUsage(usage, fix);
      const fixed = buildChainLetters(fix.text);
      if (fixed.parsed.length >= 3 && fixed.letters.length === letters.length && countB(fixed.letters) >= countB(letters)) {
        letters = fixed.letters;
        const remaining = checkLetterRules(lettersForCheck(letters), language, facts);
        if (remaining.length > 0) {
          stageLog(
            ctx,
            `[chain] после фикс-прохода осталось ${remaining.length} нарушений: ${remaining
              .slice(0, 3)
              .map((v) => v.detail)
              .join('; ')}`,
          );
        }
      } else {
        stageLog(
          ctx,
          `[chain] фикс-проход: ${fixed.parsed.length} писем/${countB(fixed.letters)} B-вариантов вместо ${letters.length}/${countB(letters)} — оставляем исходные`,
        );
      }
    } catch (e) {
      stageLog(ctx, `[chain] фикс-проход недоступен: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Критик-луп: одна оценка цепочки той же моделью, что и генерация
  // (getVeModel('chain')), + максимум один rewrite по её замечаниям. Критик
  // работает ТОЛЬКО по основному варианту A (B-варианты в разбор не идут —
  // стоимость; считаются ревьюированными неявно); после рерайта B-варианты
  // восстанавливаются из исходных писем по индексу. Без цикла. Сбой критика,
  // а также нечитаемый, урезанный или раздутый rewrite → остаются исходные
  // письма (стадию это не валит).
  let critiqueInfo: { verdict: string; issues_count: number; rewritten: boolean } | null = null;
  try {
    const criticLetters = letters.map((l) => ({ subject: l.subject ?? '', body: l.body }));
    const critique = await callLLMWithSchema(
      buildChainCriticMessages({
        verticalName: vertical.name,
        verticalSummary: vertical.summary ?? '',
        letters: criticLetters,
        language,
        styleExample,
        winnerPatterns,
      }),
      VeChainCritiqueSchema,
      { model, maxTokens: 4096 },
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
        buildChainRewriteMessages({
          verticalName: vertical.name,
          letters: criticLetters,
          critique: { ...critique.data, issues },
          language,
          styleExample,
          winnerPatterns,
          signatureOverride,
        }),
        { model, maxTokens: 16384 },
      );
      addUsage(usage, rewrite);
      // Рерайт выводит только основной вариант (---LETTER N B--- блоков в
      // нём нет — см. REWRITE_TASK); сплиттер на всякий случай прогоняем,
      // чтобы эхо B-маркера не склеилось в тело письма.
      const rewritten = parseLettersFromModelOutput(extractLetterBVariants(rewrite.text).cleaned);
      // Принимаем rewrite только при точном совпадении числа писем: иначе
      // ломаются лесенка wait_days и индексация писем.
      if (rewritten.length === letters.length) {
        const originalLetters = letters;
        letters = parsedToChainLetters(rewritten.slice(0, 6)).map((l, i): VeChainLetterAB => {
          const { variants: _legacy, ...rest } = l;
          const bv = originalLetters[i]?.variants;
          return bv?.length ? { ...rest, variants: bv } : rest;
        });
        critiqueInfo.rewritten = true;
      } else {
        stageLog(ctx, `[chain] rewrite критика: ${rewritten.length} писем вместо ${letters.length} — оставляем исходные`);
      }
    }
  } catch (e) {
    stageLog(ctx, `[chain] критик-луп недоступен: ${e instanceof Error ? e.message : String(e)} — оставляем исходные письма`);
  }

  // Read after all model rewrites: a specialist may have saved new gaps while
  // generation was running. Timing belongs to the vertical, not its language.
  const { data: latestChain, error: timingError } = await ctx.supabase
    .from('ve_chains')
    .select('letters')
    .eq('vertical_id', verticalId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (timingError) throw new Error(`ve_chains timing read: ${timingError.message}`);
  letters = applyVeChainTiming(letters, Array.isArray(latestChain?.letters) ? latestChain.letters : undefined);

  const { data: inserted, error: insError } = await ctx.supabase
    .from('ve_chains')
    .insert({
      vertical_id: verticalId,
      language,
      letters,
      status: 'ready',
      llm_model: model,
      tokens_used: usage.tokensUsed,
      cost_usd: usage.costUsd,
    })
    .select('id')
    .single();
  if (insError || !inserted) throw new Error(`ve_chains insert: ${insError?.message ?? 'unknown'}`);

  return {
    result: { chain_id: (inserted as { id: string }).id, letters, critique: critiqueInfo },
    tokensUsed: usage.tokensUsed,
    costUsd: usage.costUsd,
  };
}
