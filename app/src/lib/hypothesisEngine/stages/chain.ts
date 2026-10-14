/**
 * Стадия chain: вертикаль + бриф проекта → цепочка из 3–5 писем (EN — ровно
 * 4: цель промпта и порог повтора, см. HE_CHAIN_TARGET_LETTERS_EN).
 * Промпт-архитектура emailSequenceV2 (материалы → праймер → задача) +
 * CHAIN_REGULATIONS; ответ парсится маркерами ---LETTER N--- через
 * letterParser, A/B-варианты (---LETTER N B---, у каждого письма второй
 * повод/угол) вырезаются пост-сплиттером extractLetterBVariants ДО
 * letterParser (он общий с emailSequenceV2 и не знает про B-маркеры).
 * Языки: ru/en/pl (job.payload.language).
 * Разметка специалиста (he_hypotheses.status) учитывается через
 * selectPromptHypotheses: rejected исключаются, accepted — первыми.
 * В промпт подмешиваются style_override из брифа (styleExample),
 * signature_override (дословная подпись отправителя) и winner-паттерны
 * датасета (best-effort). Перед критиком — детерминированный контроль
 * (letterChecks): тире/приветствие/один CTA/стоп-фразы + числа только из
 * материалов; нарушения чинятся одним фикс-проходом. После — критик-луп:
 * одна оценка цепочки (только основной вариант A) + максимум один rewrite
 * по её замечаниям; B-варианты после рерайта восстанавливаются из исходных.
 * EN: ответ фикс-прохода, в котором чисел не из материалов больше, чем в
 * письмах до него, не принимается; критик и рерайт видят «CLIENT'S OWN
 * WORDS», а рерайт, после которого чисел не из материалов стало больше,
 * откатывается (см. критик-луп ниже). Английская цепочка проекта 'us' получает
 * бриф без пожеланий клиента по таргетингу — рамки ЦА и target_audience
 * профиля (briefWithoutTargetingWishes): ни в материалах, ни в корпусе чисел.
 * Цепочка 'us', когда клиент подтверждённо не мы (letterBrandGuard: английская
 * и польская — всегда, русская — у проекта клиента ENG-кабинета): чужая
 * компания в письмах (наш бренд «Polza» /
 * «OutreachOS» или вымышленная компания из примера EN-промпта) идёт пунктами в
 * тот же фикс-проход (ответ с бОльшим числом упоминаний не принимается),
 * рерайт, добавивший упоминания, откатывается, а цепочка, в которой они
 * остались, не сохраняется: стадия падает HeLetterBrandLeakError (не
 * терминально — воркер повторит стадию новой генерацией). Если наш бренд
 * назван в поле брифа, которое промпт берёт дословно (подпись, оффер,
 * описание бизнеса), стадия отказывает ДО первого платного вызова
 * HeLetterBrandInputError (терминально и бесплатно: с тем же брифом повтор
 * упал бы так же, а попытку воркер не засчитывает). Русская цепочка
 * us-проекта агентского клиента staff-инструмента не проверяется (роль
 * RU-промпта — «Polza»).
 */

import { z } from 'zod';

import { parseLettersFromModelOutput, type ParsedLetter } from '@/lib/emailSequenceV2/letterParser';
import { stripUnstorableJsonChars } from '@/lib/jsonbSafe';
import { callLLMText, callLLMTextWithFallback, callLLMWithSchema, getHeModel, type LLMMessage } from '../llm';
import {
  buildChainCriticMessages,
  buildChainMessages,
  buildChainRewriteMessages,
  buildChainRuleFixHint,
  clientWordsFromBrief,
} from '../prompts/chain';
import { checkLetterParagraphs, checkLetterRules, extractNumberFacts, type HeLetterForCheck } from '../letterChecks';
import {
  HeLetterBrandInputError,
  HeLetterBrandLeakError,
  describeHeBrandInputLeaks,
  describeHeBrandLeaks,
  findHeBrandLeaks,
  heBrandInputLeaks,
  heBrandLeakFixItems,
  heLetterBrandGuard,
  heLetterBrandLeaks,
  readHeBrandEngClient,
} from '../letterBrandGuard';
import { getWinnerPatterns, matchSegmentLabels, type HeWinnerPattern } from '../datasetStats';
import { projectMarket } from '../market';
import { selectCaseForVertical, type HeCase } from '../caseBank';
import type { HeChainLanguage, HeChainLetter, HeEvidenceItem, HeHypothesis, HeJob, HeVertical } from '../types';
import {
  addUsage,
  newUsage,
  payloadString,
  readProject,
  stageLog,
  type HeStageContext,
  type HeStageResult,
} from './shared';

/** Паузы в днях после предыдущего письма по индексу письма (0-based). */
export const CHAIN_WAIT_DAYS = [0, 3, 7, 12, 16, 21];

/** ParsedLetter[] letterParser → HeChainLetter[] с лесенкой wait_days. */
export function parsedToChainLetters(parsed: ParsedLetter[]): HeChainLetter[] {
  return parsed.map((l, i) => ({
    subject: l.subject,
    body: l.body,
    wait_days: CHAIN_WAIT_DAYS[Math.min(i, CHAIN_WAIT_DAYS.length - 1)],
  }));
}

/* ───────────────── A/B-варианты писем (---LETTER N B---) ───────────────── */

/** A/B-вариант письма: тема+тело альтернативного повода/угла (A — основной subject/body). */
export interface HeChainLetterVariant {
  subject: string | null;
  body: string;
}

/**
 * Письмо цепочки с A/B-вариантом: variants хранит объект {subject, body}
 * варианта B (вариант A — само письмо). В types.ts поле HeChainLetter.variants
 * объявлено как legacy string[] и не используется; фактический jsonb-контракт
 * he_chains/he_templates фиксируем здесь (types.ts вне скоупа итерации).
 */
export type HeChainLetterAB = Omit<HeChainLetter, 'variants'> & {
  variants?: HeChainLetterVariant[];
};

/** Маркер варианта B: ---LETTER 2 B--- (регистр и пробелы толерантны). */
const LETTER_B_MARKER_RE = /---\s*LETTER\s*(\d+)\s*B\s*---/gi;

export interface LetterBExtraction {
  /** Текст без B-блоков — только основные письма (для letterParser). */
  cleaned: string;
  /** Вариант B по 1-based индексу письма (перенумерация как в letterParser). */
  variants: Map<number, HeChainLetterVariant>;
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

  const variants = new Map<number, HeChainLetterVariant>();
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
export function buildChainLetters(raw: string): { parsed: ParsedLetter[]; letters: HeChainLetterAB[] } {
  const ab = extractLetterBVariants(raw);
  const parsed = parseLettersFromModelOutput(ab.cleaned);
  const sliced = parsed.slice(0, 6);
  const letters = parsedToChainLetters(sliced).map((l, i): HeChainLetterAB => {
    const { variants: _legacy, ...rest } = l;
    const bv = ab.variants.get(sliced[i]?.letter_index ?? i + 1);
    return bv ? { ...rest, variants: [bv] } : rest;
  });
  return { parsed, letters };
}

/**
 * Разметка специалиста (he_hypotheses.status: proposed/accepted/rejected) →
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
 * Zod-схема ответа критика цепочки — зеркало контракта HeChainCritique из
 * prompts/chain (вердикт + проблемы с фиксами по индексам писем). Локальная
 * для стадий (в schemas.ts не выносим); template-стадия переиспользует её же.
 */
export const HeChainCritiqueSchema = z.object({
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

/**
 * EN-цепочка — цель ровно 4 письма (пункт переноса D2-letters-chain-exactly-four;
 * сам кабинет ENG числа не навязывает: показывает и отправляет столько шагов,
 * сколько писем в цепочке). Ответ короче — один повтор с английской
 * подсказкой, из двух ответов берётся тот, где писем больше (при равенстве —
 * повтор). Ответ длиннее 4 принимается
 * как есть: повтор стоил бы ещё один платный вызов, а обрезка выкинула бы
 * последнее (реферальное) письмо. RU/PL — прежний порог «меньше 3 → повтор»;
 * нижний порог отказа (меньше 3 писем после повтора) общий для всех языков.
 */
export const HE_CHAIN_TARGET_LETTERS_EN = 4;

/** Подсказка повтора EN-цепочки: английская, иначе русский текст уходит посреди английской генерации. */
const RETRY_HINT_EN = `You returned too few emails or broke the format. The sequence needs exactly ${HE_CHAIN_TARGET_LETTERS_EN} emails, each as a "---LETTER N---" block with a "Subject:" line, plus each email's B variant as a "---LETTER N B---" block right after it. Return the whole sequence again, with no explanations.`;

/**
 * Бриф английской цепочки проекта 'us' без ПОЖЕЛАНИЙ клиента по таргетингу:
 *  - `icp` (рамка ЦА: include / exclude / size / geo) — кого клиент ХОЧЕТ
 *    найти или обойти. Своё дело она сделала в research: гипотезы и вертикали
 *    выбраны по ней, а письма идут в выбранную вертикаль (её имя, описание и
 *    гипотезы — в материалах отдельно);
 *  - `site_profile.target_audience` — единственное поле профиля, которое
 *    EN-промпт профиля разрешает строить по этим пожеланиям
 *    (prompts/siteProfile.en.ts). Пометить, какая часть поля с сайта, а какая
 *    из пожеланий, нечем — поэтому поле уходит целиком.
 * В материалах цепочки, где «бриф — это оффер и USP», пожелание читалось бы
 * фактом: «мы помогаем стоматологиям» у клиента, среди клиентов которого
 * стоматологий нет, — выдуманное доказательство в письме, которое из пула
 * уходит без проверки человеком. Подпись «это пожелание, не факт» — только
 * просьба к модели; отсутствие поля в материалах — гарантия кода. Остальной
 * бриф (профиль сайта с current_clients и cases — дословно с сайта, см.
 * keepSiteLiteralProof в stages/siteProfile.ts) и порядок ключей — прежние.
 * Русская и польская цепочки и английская цепочка проекта 'ru' (его профиль
 * строится без брифа) получают бриф как раньше.
 */
function briefWithoutTargetingWishes(brief: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(brief)) {
    if (key === 'icp') continue;
    if (key === 'site_profile' && value && typeof value === 'object' && !Array.isArray(value)) {
      const { target_audience: _wishShaped, ...profile } = value as Record<string, unknown>;
      out[key] = profile;
      continue;
    }
    out[key] = value;
  }
  return out;
}

export async function runChainStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();
  const verticalId = payloadString(job, 'vertical_id');
  const language = (typeof job.payload?.language === 'string' ? job.payload.language : 'ru') as HeChainLanguage;

  const { data: verticalRow, error: vError } = await ctx.supabase
    .from('he_verticals')
    .select('*')
    .eq('id', verticalId)
    .single();
  if (vError || !verticalRow) throw new Error(`he_verticals ${verticalId}: ${vError?.message ?? 'not found'}`);
  const vertical = verticalRow as HeVertical;

  const project = await readProject(ctx.supabase, job.project_id);

  const { data: hyps, error: hError } = await ctx.supabase
    .from('he_hypotheses')
    .select('*')
    .eq('project_id', job.project_id)
    .eq('vertical_id', verticalId)
    .order('potential_pct', { ascending: false });
  if (hError) throw new Error(`he_hypotheses read: ${hError.message}`);
  // Разметка специалиста: rejected уходят из промпта, accepted — первыми.
  const selection = selectPromptHypotheses((hyps ?? []) as HeHypothesis[]);
  if (selection.fallbackUsed) {
    stageLog(ctx, '[chain] все гипотезы вертикали отклонены специалистом — используем полный список без разметки');
  }
  const hypotheses = selection.list;

  const brief = (project.brief ?? {}) as Record<string, unknown>;
  // style_override/offer_override/signature_override попадают в промпт
  // отдельными блоками (styleExample / offerOverride / signatureOverride) —
  // из JSON-снапшота брифа их вырезаем, чтобы не дублировать длинные тексты
  // в материалах.
  const { style_override: _s, offer_override: _o, signature_override: _sig, ...briefRest } = brief;
  // EN: business_override тоже уходит отдельным блоком («CLIENT'S OWN WORDS»
  // вместе с оффером) — из JSON брифа EN-промпта его вырезаем. RU/PL видят
  // бриф как раньше (business_override внутри JSON).
  const { business_override: _biz, ...briefRestEn } = briefRest;
  const businessOverride = typeof brief.business_override === 'string' ? brief.business_override : undefined;

  // Кейс-банк: лучший кейс клиента под вертикаль → главное доказательство
  // цепочки. Best-effort: сбой чтения he_cases не роняет генерацию.
  let clientCase: HeCase | null = null;
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
  // Рынок обязателен: словарь SEGMENT_LABEL_KEYWORDS содержит и английские
  // токены (saas, logistics, retail), поэтому ENG-вертикаль матчится на
  // RU-сегменты, и в английскую генерацию уезжают русские темы кампаний
  // вместе с русским текстом самого блока (renderWinnerPatternsBlock).
  const market = ctx.market ?? projectMarket(project);
  // Снапшот брифа для материалов и корпуса чисел. Английская цепочка проекта
  // 'us' — без пожеланий клиента по таргетингу (briefWithoutTargetingWishes).
  const briefForPrompt =
    language === 'en' ? (market === 'us' ? briefWithoutTargetingWishes(briefRestEn) : briefRestEn) : briefRest;
  // Цепочка 'us': чужая компания в письмах (letterBrandGuard). Список не пуст,
  // только когда клиент подтверждённо не мы (хост сайта проекта не наш) и
  // цепочка английская или польская — или владелец проекта клиент
  // ENG-кабинета (тогда и русская: его письма уходят из нашего пула). RU и наш
  // собственный проект — пустой список всегда. Профиль владельца читается
  // только там, где он меняет ответ (русская цепочка 'us').
  const heEngClient =
    market === 'us' && language === 'ru' ? await readHeBrandEngClient(ctx.supabase, project.created_by) : false;
  const brandGuard = heLetterBrandGuard(market, { ...project, heEngClient }, language);
  const brandLeaksOf = (ls: HeChainLetterAB[]) => heLetterBrandLeaks(brandGuard, ls);
  // Наш бренд в поле брифа, которое промпт берёт дословно: письма с ним не
  // пройдут проверку ни в одном прогоне — отказ до первого платного вызова.
  const brandInputs = heBrandInputLeaks(brandGuard, brief);
  if (brandInputs.length) {
    stageLog(
      ctx,
      `[chain] поле брифа называет наш бренд, а клиент проекта — другая компания: генерацию не начинаем — ${describeHeBrandInputLeaks(brandInputs)}`,
    );
    throw new HeLetterBrandInputError('chain', brandInputs);
  }
  let winnerPatterns: HeWinnerPattern[] = [];
  try {
    const terms = [vertical.name, ...(Array.isArray(vertical.synonyms) ? vertical.synonyms : [])];
    const labels = matchSegmentLabels(terms);
    winnerPatterns = await getWinnerPatterns(labels.length ? labels : [vertical.name], 5, { market });
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
      evidence: (Array.isArray(h.evidence) ? h.evidence : []) as HeEvidenceItem[],
    })),
    briefText: JSON.stringify(briefForPrompt),
    offerOverride: typeof brief.offer_override === 'string' ? brief.offer_override : undefined,
    businessOverride,
    operatorsHint: typeof job.payload?.operators_hint === 'string' ? job.payload.operators_hint : undefined,
    clientCase,
    styleExample,
    winnerPatterns,
    signatureOverride,
  });

  const model = getHeModel('chain');
  let llm = await callLLMTextWithFallback(messages, { model, maxTokens: 16384, log: (m) => stageLog(ctx, m) });
  addUsage(usage, llm);
  let { parsed, letters } = buildChainLetters(llm.text);

  // Порог повтора: EN — меньше 4 писем (цепочка ровно из 4), RU/PL — меньше 3.
  const retryBelow = language === 'en' ? HE_CHAIN_TARGET_LETTERS_EN : 3;
  if (parsed.length < retryBelow) {
    stageLog(
      ctx,
      language === 'en'
        ? `[chain] распознано ${parsed.length} писем из ${HE_CHAIN_TARGET_LETTERS_EN} — retry с фидбэком`
        : `[chain] распознано ${parsed.length} писем — retry с фидбэком`,
    );
    const first = { parsed, letters, llm };
    const retryMessages: LLMMessage[] = [
      ...messages,
      { role: 'assistant', content: llm.text.slice(0, 2000) },
      { role: 'user', content: language === 'en' ? RETRY_HINT_EN : RETRY_HINT },
    ];
    llm = await callLLMTextWithFallback(retryMessages, { model, maxTokens: 16384, log: (m) => stageLog(ctx, m) });
    addUsage(usage, llm);
    ({ parsed, letters } = buildChainLetters(llm.text));
    // EN: из двух оплаченных ответов оставляем тот, где писем больше (как V2):
    // повтор, вернувший меньше, не должен отнять уже годную цепочку из 3.
    if (language === 'en' && parsed.length < first.parsed.length) ({ parsed, letters, llm } = first);
  }
  if (parsed.length < 3) {
    // Диагностика в ошибку (пишется в he_jobs.error): начало сырого ответа,
    // чтобы по проду было видно формат без реплея. Отдельно размечаем отказ
    // по контентной политике (регулируемые ниши: крипто, финансы и т.п.).
    const debug = llm.text.replace(/\s+/g, ' ').slice(0, 300);
    const refusal = llm.finishReason === 'content_filter' || llm.text.length < 20
      ? ` Модель, похоже, отклонила генерацию по контентной политике (finish=${llm.finishReason ?? 'n/a'}): чувствительная ниша клиента — попробуйте переписать оффер/бриф нейтральнее или другую модель (HE_MODEL_CHAIN/HE_MODEL_CHAIN_FALLBACK).`
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
          ...((Array.isArray(h.evidence) ? h.evidence : []) as HeEvidenceItem[]).map(
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
    JSON.stringify(briefForPrompt),
    typeof brief.offer_override === 'string' ? brief.offer_override : '',
    // EN: business_override вырезан из JSON брифа выше — цифры клиента из
    // его описания бизнеса возвращаем в корпус явно, иначе они станут
    // «выдуманными». У RU/PL он и так внутри JSON брифа — корпус прежний.
    ...(language === 'en' ? [businessOverride ?? ''] : []),
    styleExample ?? '',
    signatureOverride ?? '',
    JSON.stringify(winnerPatterns),
  ].join('\n');
  // EN читает числа по-английски («10,000» — 10000); письма сверяются тем же
  // чтением (letterChecks помнит, как прочитан корпус).
  const facts = extractNumberFacts(factCorpus, language);
  // letterIndex — номер письма в цепочке для detail нарушений (учитывается для EN).
  const lettersForCheck = (ls: HeChainLetterAB[]): HeLetterForCheck[] =>
    ls.flatMap((l, i) => [
      { subject: l.subject ?? '', body: l.body, variant: 'A', letterIndex: i + 1 },
      ...(l.variants ?? []).map((v) => ({ subject: v.subject ?? '', body: v.body, variant: 'B', letterIndex: i + 1 })),
    ]);
  const ruleViolations = checkLetterRules(lettersForCheck(letters), language, facts);
  // 'us', проверка включена (letterBrandGuard): чужая компания в письмах клиента (brandLeaksOf; иначе пусто) запускает
  // этот же фикс-проход своими пунктами — без него цепочка не сохранится (ниже).
  const brandLeaksBeforeFix = brandLeaksOf(letters);
  if (ruleViolations.length > 0 || brandLeaksBeforeFix.length > 0) {
    stageLog(
      ctx,
      `[chain] детерминированный контроль: ${ruleViolations.length} нарушений${
        brandLeaksBeforeFix.length ? `, чужая компания в письмах: ${describeHeBrandLeaks(brandLeaksBeforeFix)}` : ''
      } — фикс-проход`,
    );
    // Принятие фикса: то же число писем и НЕ меньше B-вариантов (модель могла
    // молча выкинуть блоки ---LETTER N B--- — принять такое нельзя). EN — и
    // не больше чисел не из материалов, чем в письмах до него: фикс
    // переписывает цепочку целиком и мог вписать цифру, которой в материалах
    // нет, а рерайт ниже сравнивает числа уже с письмами после фикса. Письма
    // цепочки стадия template кладёт в свой корпус фактов, и такая цифра там
    // считалась бы проверенной. 'us', проверка включена — и не больше упоминаний чужой компании,
    // чем до него. Вызов фикса уже оплачен; новых вызовов нет.
    const countB = (ls: HeChainLetterAB[]) => ls.reduce((acc, l) => acc + (l.variants?.length ?? 0), 0);
    try {
      const fixMessages: LLMMessage[] = [
        ...messages,
        { role: 'assistant', content: llm.text },
        {
          role: 'user',
          content: buildChainRuleFixHint(
            [...ruleViolations, ...heBrandLeakFixItems(brandLeaksBeforeFix, language, brandGuard.clientCompany)],
            language,
          ),
        },
      ];
      const fix = await callLLMText(fixMessages, { model, maxTokens: 16384 });
      addUsage(usage, fix);
      const fixed = buildChainLetters(fix.text);
      if (fixed.parsed.length >= 3 && fixed.letters.length === letters.length && countB(fixed.letters) >= countB(letters)) {
        const remaining = checkLetterRules(lettersForCheck(fixed.letters), language, facts);
        const numbersBefore = language === 'en' ? ruleViolations.filter((v) => v.rule === 'unverified_number').length : 0;
        const numbersAfter = language === 'en' ? remaining.filter((v) => v.rule === 'unverified_number') : [];
        const brandAfterFix = brandLeaksOf(fixed.letters);
        if (numbersAfter.length > numbersBefore) {
          stageLog(
            ctx,
            `[chain] фикс-проход: чисел не из материалов ${numbersAfter.length} (было ${numbersBefore}) — оставляем исходные; ${numbersAfter
              .slice(0, 3)
              .map((v) => v.detail)
              .join('; ')}`,
          );
        } else if (brandAfterFix.length > brandLeaksBeforeFix.length) {
          stageLog(
            ctx,
            `[chain] фикс-проход: чужая компания в письмах ${brandAfterFix.length} раз (было ${brandLeaksBeforeFix.length}) — оставляем исходные; ${describeHeBrandLeaks(brandAfterFix, 3)}`,
          );
        } else {
          letters = fixed.letters;
          if (remaining.length > 0) {
            stageLog(
              ctx,
              `[chain] после фикс-прохода осталось ${remaining.length} нарушений: ${remaining
                .slice(0, 3)
                .map((v) => v.detail)
                .join('; ')}`,
            );
          }
          if (brandAfterFix.length > 0) {
            stageLog(ctx, `[chain] после фикс-прохода чужая компания в письмах осталась: ${describeHeBrandLeaks(brandAfterFix)}`);
          }
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
  // (getHeModel('chain')), + максимум один rewrite по её замечаниям. Критик
  // работает ТОЛЬКО по основному варианту A (B-варианты в разбор не идут —
  // стоимость; считаются ревьюированными неявно); после рерайта B-варианты
  // восстанавливаются из исходных писем по индексу. Без цикла. Сбой критика,
  // а также нечитаемый, урезанный или раздутый rewrite → остаются исходные
  // письма (стадию это не валит).
  //
  // EN: критик и рерайт получают «CLIENT'S OWN WORDS» (сборщики промптов
  // читают clientWords только для 'en'). Рерайт фикс-проход уже не проходит,
  // поэтому его письма заново сверяются checkLetterRules с тем же корпусом
  // фактов (бесплатно, без вызова модели), и рерайт ОТКАТЫВАЕТСЯ к письмам до
  // него, когда нарушений 'unverified_number' стало больше: «$35,000» →
  // «$35k», «we helped 40 clinics». Решает только это правило. Число в
  // цепочке — не только текст на шаге Letters: стадия template кладёт письма
  // цепочки в свой корпус фактов, и выдуманная здесь цифра там уже считалась
  // бы проверенной. Тире, приветствие, «?» и абзацы рерайт не откатывают: их
  // письма шаблона проверяют сами, а откат по ним выбросил бы и правки
  // критика по смыслу (например, снятое обещание несуществующего отчёта).
  // Сам рерайт к этому моменту уже оплачен. RU/PL — как раньше.
  const clientWords = clientWordsFromBrief(brief);
  const unverifiedNumbers = (ls: HeChainLetterAB[]) =>
    checkLetterRules(lettersForCheck(ls), language, facts).filter((v) => v.rule === 'unverified_number');
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
        clientWords,
      }),
      HeChainCritiqueSchema,
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
          clientWords,
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
        const candidate = parsedToChainLetters(rewritten.slice(0, 6)).map((l, i): HeChainLetterAB => {
          const { variants: _legacy, ...rest } = l;
          const bv = originalLetters[i]?.variants;
          return bv?.length ? { ...rest, variants: bv } : rest;
        });
        // EN: числа не из материалов — до рерайта и после (B-варианты в обоих
        // наборах одни и те же, исходные).
        const numbersBefore = language === 'en' ? unverifiedNumbers(originalLetters).length : 0;
        const numbersAfter = language === 'en' ? unverifiedNumbers(candidate) : [];
        // 'us', проверка включена (letterBrandGuard): рерайт, после которого упоминаний чужой компании больше, чем до
        // него, тоже откатывается — иначе цепочка не сохранится (ниже).
        const brandBefore = brandLeaksOf(originalLetters).length;
        const brandAfter = brandLeaksOf(candidate);
        if (numbersAfter.length > numbersBefore) {
          stageLog(
            ctx,
            `[chain] rewrite критика откатили к письмам до него: чисел не из материалов ${numbersAfter.length} ` +
              `(было ${numbersBefore}) — ${numbersAfter
                .slice(0, 3)
                .map((v) => v.detail)
                .join('; ')}`,
          );
        } else if (brandAfter.length > brandBefore) {
          stageLog(
            ctx,
            `[chain] rewrite критика откатили к письмам до него: чужая компания в письмах ${brandAfter.length} раз ` +
              `(было ${brandBefore}) — ${describeHeBrandLeaks(brandAfter, 3)}`,
          );
        } else {
          letters = candidate;
          critiqueInfo.rewritten = true;
        }
      } else {
        stageLog(ctx, `[chain] rewrite критика: ${rewritten.length} писем вместо ${letters.length} — оставляем исходные`);
      }
    }
  } catch (e) {
    stageLog(ctx, `[chain] критик-луп недоступен: ${e instanceof Error ? e.message : String(e)} — оставляем исходные письма`);
  }

  // Абзацы EN-писем: только предупреждение в логе стадии, без фикс-прохода и
  // без блокировки (letterChecks.checkLetterParagraphs; RU/PL — пустой список).
  const paragraphWarnings = checkLetterParagraphs(lettersForCheck(letters), language);
  if (paragraphWarnings.length > 0) {
    stageLog(
      ctx,
      `[chain] абзацы (предупреждение, без фикс-прохода): ${paragraphWarnings.length} вариантов — ${paragraphWarnings
        .slice(0, 3)
        .map((v) => v.detail)
        .join('; ')}`,
    );
  }

  // 'us', проверка включена (letterBrandGuard): в письмах наш бренд или компания из примера промпта, а клиент
  // подтверждённо не мы — цепочку не сохраняем: клиент читает её на шаге
  // Letters, а стадия template пишет по ней итоговые письма. Ошибка не
  // терминальная (воркер повторит стадию новой генерацией, MAX_ATTEMPTS).
  // Клиента не с чем сравнить (ни сайта, ни имени компании) — проверки нет, но
  // то, что письма называют такое слово, видно в логе.
  const finalBrandLeaks = brandLeaksOf(letters);
  if (finalBrandLeaks.length) {
    stageLog(
      ctx,
      `[chain] в письмах назван наш бренд или компания из примера, а клиент проекта — другая компания: цепочку не сохраняем — ${describeHeBrandLeaks(finalBrandLeaks, 20)}`,
    );
    throw new HeLetterBrandLeakError('chain', finalBrandLeaks);
  }
  if (market === 'us' && language === 'en' && brandGuard.ownership === 'unknown') {
    const named = findHeBrandLeaks(letters);
    if (named.length) {
      stageLog(
        ctx,
        `[chain] письма называют наш бренд или компанию из примера (${describeHeBrandLeaks(named, 6)}), но ни сайта, ни имени компании клиента нет — сравнить не с чем, цепочку не держим`,
      );
    }
  }

  // letters — текст модели (темы, тела, B-варианты): один NUL или одиночный
  // UTF-16 суррогат, и PostgREST отвергает вставку уже после всех оплаченных
  // вызовов (генерация, фикс-проход, критик, рерайт) — стадия падает и на
  // повторе покупает цепочку заново. Чистка трогает только эти два символа:
  // текст без них (вся кириллица и латиница) ложится байт-в-байт тем же.
  const { data: inserted, error: insError } = await ctx.supabase
    .from('he_chains')
    .insert(stripUnstorableJsonChars({
      vertical_id: verticalId,
      language,
      letters,
      status: 'ready',
      llm_model: model,
      tokens_used: usage.tokensUsed,
      cost_usd: usage.costUsd,
    }))
    .select('id')
    .single();
  if (insError || !inserted) throw new Error(`he_chains insert: ${insError?.message ?? 'unknown'}`);

  return {
    result: { chain_id: (inserted as { id: string }).id, letters, critique: critiqueInfo },
    tokensUsed: usage.tokensUsed,
    costUsd: usage.costUsd,
  };
}
