/**
 * Стадия template: база + вертикаль + цепочка → финальный шаблон 85/15.
 *  1) LLM-план (fixed_block ~85% + personalization_plan + letters[].segment_variants);
 *  2) LLM финальных писем по плану (маркеры ---LETTER N--- + ---SEGMENT: <when>---,
 *     у письма 1 — A/B-вариант ---LETTER 1 B---): основной текст — дефолт для
 *     всей базы, сегментные варианты хранятся отдельно
 *     (letters[].segment_variants), B-вариант — в letters[].variants,
 *     wait_days — лесенка CHAIN_WAIT_DAYS из stages/chain, а у 'us' перед
 *     записью — паузы he_chains.letters по номеру письма, лесенка только там,
 *     где у цепочки паузы нет (chainTiming.ts);
 *  3) пост-проверки с одним retry каждая: длина тел (≤80 слов, письмо 1 ≤70) и
 *     консистентность operator_mapping (см. validateOperatorMapping); у 'us'
 *     повтор по операторам запускает и предсказанный отказ гейта отправки
 *     (шаг 4b), с его английским описанием в подсказке;
 *  4) pure-маппинг операторов {{var}} финальных писем на колонки базы;
 *  4b) ТОЛЬКО рынок 'us' — гейт отправки (templateOperatorGate): бесплатная
 *      починка строки приветствия («Hello {{firstName}},» без колонки имени →
 *      «Hello,») и замена пустой ячейки по виду колонки («your website») в
 *      fallback маппинга; письма, где после них остался оператор без данных
 *      (в теме письма 1 без колонки, где угодно без колонки и fallback, битые
 *      {{…}}, пустая ячейка без замены или с заменой не к месту), в
 *      he_templates НЕ пишутся: стадия падает HeTemplateOperatorGateError.
 *      RU — как раньше: дыры маппинга только в логе, шаблон 'ready';
 *  5) insert в he_templates (status 'ready', llm_model) — другого статуса
 *     стадия не пишет.
 * До шага 1, без единого платного вызова: у проекта 'us' база читается только
 * своего проекта, а пустая база (row_count 0) — отказ (у 'ru' — как до
 * переноса ENG); у любого рынка готовый шаблон базы возвращается как
 * есть (result.reused, расход 0): любой — только по payload.reuse (пути ENG),
 * без него — только вставленный прошлой попыткой этой же джобы; см.
 * findReusableTemplate про флаги и про письма с чужой компанией (их не
 * возвращает).
 * В промпты подмешиваются style_override из брифа (styleExample),
 * signature_override (дословная подпись отправителя) и winner-паттерны
 * датасета (best-effort); у английских писем 'us' — ещё слова клиента из брифа (offer_override,
 * business_override → блок «CLIENT'S OWN WORDS» плана, писем, критика и
 * рерайта). После генерации писем — критик-луп: одна оценка (только основной
 * вариант A) + максимум один rewrite по её замечаниям; B-вариант и сегментные
 * варианты после рерайта восстанавливаются из исходных писем.
 *
 * РЫНОК РЕШАЕТ, А НЕ ЯЗЫК (решение владельца 14.10.2026 «Как было»). Всё, что
 * перенос ENG поменял в письмах, действует только у проекта рынка 'us'; у
 * проекта 'ru' (staff-инструмент, где сотрудник выбирает и английскую
 * цепочку) стадия — ровно та, что до переноса: прежние промпты, пороги и
 * подсказки повторов, русское чтение чисел, рерайт критика без отката, без
 * personalization_plan.rule_violations, запись he_templates без чистки
 * текста. Остаётся у всех только переиспользование готового шаблона по явной
 * просьбе (findReusableTemplate).
 *
 * Только английские письма проекта 'us' (letterChecks.heUsEnglishLetters),
 * RU/PL и английские письма проекта 'ru' как раньше:
 *  - шаблон не короче цепочки, насколько это даёт один повтор: писем меньше,
 *    чем в he_chains.letters, → тот же один повтор генерации, что и при < 3
 *    писем, с английской подсказкой (короче цепочки, но не меньше 3, шаблон
 *    после него принимается — только с записью в лог); из двух ответов —
 *    ближайший к числу писем цепочки, но не меньше 3; укороченный
 *    ответ сокращения тел (шаг 2b) не принимается, если он дальше от цели;
 *  - все подсказки повторов модели — по-английски;
 *  - ответ фикс-прохода (шаг 2c), в котором непроверенных чисел больше, чем
 *    в письмах до него, не принимается: остаются письма до него;
 *  - рерайт критика откатывается к письмам до него только за рост числа
 *    непроверенных чисел (и, у 'us', за сломанный гейт — ниже). Тире,
 *    приветствие, «?», стоп-фразы и абзацы его не откатывают: откат выбросил
 *    бы и правки критика по смыслу (обещание без опоры, утверждение о рынке
 *    получателя, которого отправитель знать не может). Регламент финальных
 *    писем, с абзацами, — только предупреждение: personalization_plan.rule_violations
 *    (staff-экран шаблона) и лог.
 * Только 'us': модель плана не видит колонок с пустыми ячейками без замены
 * (heColumnsWithoutStandIn); повтор по операторам, после которого гейт
 * отправки перестал пропускать письма (или нашёл больше проблем), тоже
 * откатывается, а снявший его отказ принимается, если не добавил
 * непроверенных чисел (lettersRegression); рерайт критика откатывается, если
 * гейт пропускал письма до него и не пропускает после.
 * Письма 'us', когда клиент подтверждённо не мы (letterBrandGuard: хост сайта
 * не наш; английские и польские — всегда, русские — у проекта клиента
 * ENG-кабинета): чужая компания в письмах (наш бренд
 * «Polza» / «OutreachOS» или вымышленная компания из примера EN-промпта) —
 * провал того же рода, что гейт отправки. Её упоминания идут пунктами в
 * фикс-проход (шаг 2c, ответ с бОльшим их числом не принимается), запускают
 * тот же единственный повтор шага 2d (повтор, добавивший их, — откат),
 * откатывают рерайт критика, который их добавил, а шаг 3b такой шаблон не
 * пишет: стадия падает HeLetterBrandLeakError, не терминально, как
 * HeTemplateOperatorGateError. Наш бренд в поле брифа, которое промпт берёт
 * дословно (подпись, оффер, описание бизнеса), — отказ ДО первого платного
 * вызова, HeLetterBrandInputError (терминально и бесплатно: попытку воркер не
 * засчитывает). Готовый шаблон базы с чужой компанией в письмах стадия не
 * переиспользует (findReusableTemplate) — пишет новые письма. Русские письма
 * us-проекта агентского клиента staff-инструмента не проверяются (роль
 * RU-промпта — «Polza»).
 */

import { parseLettersFromModelOutput, type ParsedLetter } from '@/lib/emailSequenceV2/letterParser';
import { stripUnstorableJsonChars } from '@/lib/jsonbSafe';
import { callLLMText, callLLMTextWithFallback, callLLMWithSchema, getHeModel, type LLMMessage } from '../llm';
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
import { buildChainRuleFixHint, clientWordsFromBrief } from '../prompts/chain';
import {
  checkLetterParagraphs,
  checkLetterRules,
  extractNumberFacts,
  findUnverifiedNumbers,
  heUsEnglishLetters,
  type HeLetterForCheck,
  type HeLetterRuleViolation,
} from '../letterChecks';
import { selectCaseForVertical, type HeCase } from '../caseBank';
import { getWinnerPatterns, matchSegmentLabels, type HeWinnerPattern } from '../datasetStats';
import { projectMarket } from '../market';
import { findEmailColumn } from '../launchHandoff';
import { applyHeChainTiming } from '../chainTiming';
import {
  HE_OPERATOR_PATTERN,
  HeTemplateOperatorGateError,
  checkHeTemplateOperators,
  describeHeTemplateOperatorGate,
  heColumnsWithoutStandIn,
  heTemplateOperatorGateProblemsEn,
  repairHeNameGreetings,
  withHeEmptyCellFallbacks,
  type HeTemplateOperatorGateResult,
} from '../templateOperatorGate';
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
  heTemplateBrandLeaks,
  readHeBrandEngClient,
  type HeBrandLeak,
} from '../letterBrandGuard';
import type {
  HeBase,
  HeChain,
  HeChainLanguage,
  HeChainLetter,
  HeHypothesis,
  HeJob,
  HeLetterRuleWarning,
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

// Синтаксис оператора один на стадию и гейт отправки (templateOperatorGate).
const OPERATOR_RE = new RegExp(HE_OPERATOR_PATTERN, 'g');

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
 * Возвращает список проблем (пустой — всё чисто). opts.language === 'en' —
 * тексты по-английски (их стадия кладёт в подсказку повтора английской
 * генерации проекта 'us' и только туда); иначе — по-русски, как раньше.
 */
export function validateOperatorMapping(
  mapping: HeOperatorMapping[],
  columns: string[],
  plan: HeTemplatePlanOutput,
  opts?: { subjectOperators?: string[]; language?: HeChainLanguage },
): string[] {
  const issues: string[] = [];
  const en = opts?.language === 'en';
  const columnKeys = new Set(columns.map(normalizeKey));
  const byOperator = new Map(mapping.map((m) => [m.operator.toLowerCase(), m]));

  for (const m of mapping) {
    if (m.matched && (!m.column || !columnKeys.has(normalizeKey(m.column)))) {
      issues.push(
        en
          ? `{{${m.operator}}} is mapped to the column "${m.column ?? '—'}", which is not among the base columns`
          : `Оператор {{${m.operator}}} замаплен на колонку «${m.column ?? '—'}», которой нет среди колонок базы`,
      );
    }
  }

  for (const lp of plan.personalization_plan ?? []) {
    for (const op of lp.operators ?? []) {
      if (!byOperator.has(op.var.toLowerCase())) {
        issues.push(
          en
            ? `{{${op.var}}} from the plan (email ${lp.letter_index}) is missing from the operator mapping`
            : `Оператор {{${op.var}}} из плана (письмо ${lp.letter_index}) отсутствует в operator_mapping`,
        );
      }
    }
  }

  for (const m of mapping) {
    if (!m.matched && !m.fallback) {
      issues.push(
        en
          ? `{{${m.operator}}} maps to no base column and has no fallback`
          : `Оператор {{${m.operator}}} не замаплен на колонку базы и не имеет fallback`,
      );
    }
  }

  for (const op of opts?.subjectOperators ?? []) {
    const m = byOperator.get(op.toLowerCase());
    if (m && !m.matched) {
      issues.push(
        en
          ? `{{${m.operator}}} is used in a subject but maps to no base column (a subject cannot use a fallback)`
          : `Оператор {{${m.operator}}} используется в теме письма, но не замаплен на колонку (fallback в теме невозможен)`,
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

/** Больше писем стадия не берёт (buildLetters режет ответ модели до стольких). */
const TEMPLATE_MAX_LETTERS = 6;

/** Меньше писем шаблон не бывает: ответ короче — повтор, затем отказ стадии. */
const TEMPLATE_MIN_LETTERS = 3;

/**
 * Насколько число писем ответа далеко от цели (числа писем цепочки). Ответ
 * короче TEMPLATE_MIN_LETTERS не годится вовсе — бесконечно далеко.
 */
function letterCountDistance(count: number, target: number): number {
  return count < TEMPLATE_MIN_LETTERS ? Number.POSITIVE_INFINITY : Math.abs(count - target);
}

function emailsEn(n: number): string {
  return `${n} email${n === 1 ? '' : 's'}`;
}

/**
 * EN: подсказка повтора генерации, когда писем меньше, чем в цепочке
 * (he_chains.letters), или формат сломан. Цепочка короче минимума шаблона
 * (клиент оставил 1–2 письма) — просим минимум и дописать письма после них:
 * меньше трёх писем стадия не примет.
 */
function lengthRetryHintEn(target: number, got: number): string {
  const want = Math.max(TEMPLATE_MIN_LETTERS, target);
  const count =
    target < want
      ? `The source sequence has ${emailsEn(target)}, and a template needs at least ${want}: keep its emails in the same order and add follow-ups after them.`
      : `The template needs exactly ${emailsEn(want)}, one for each email of the source sequence and in the same order.`;
  return (
    `We could read ${emailsEn(got)} in your answer. ${count} ` +
    `Write each email as a "---LETTER N---" block with a "Subject:" line; email 1 also gets its B variant as a "---LETTER 1 B---" block; ` +
    `segment variants go in "---SEGMENT: <when>---" blocks right after their email. Return the whole template again, with no explanations.`
  );
}

/** english — английская подсказка (английские письма проекта 'us'); иначе прежняя русская. */
function shortenRetryHint(letters: HeChainLetterAB[], english: boolean): string {
  if (english) {
    const countsEn = letters.map((l, i) => `email ${i + 1}: ${countWords(l.body)} words`).join(', ');
    return (
      `Some email bodies are longer than the regulations allow (${countsEn}). The regulations are not negotiable: body ≤ 80 words, email 1 ≤ 70 words. ` +
      `Shorten every long email, keeping its meaning, the {{var}} operators, the "---LETTER 1 B---" block and the "---SEGMENT: <when>---" blocks. ` +
      `Return the whole template again, in the same format.`
    );
  }
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

/**
 * EN-вариант operatorIssuesHint. В списке — проблемы маппинга по-английски и
 * (us) отказы гейта отправки с тем, что исправить (heTemplateOperatorGateProblemsEn):
 * часть из них велит оператор убрать, поэтому «каждый оператор из плана» здесь —
 * каждый ДРУГОЙ.
 */
function operatorIssuesHintEn(issues: string[]): string {
  return (
    `The template has problems with personalization operators:\n` +
    issues.map((i) => `- ${i}`).join('\n') +
    `\n\nFix each item as it says. Every other operator in the plan must actually be used in the emails and map to a real base column; ` +
    `subjects may only use operators backed by a real column (no fallback is possible in a subject). ` +
    `Return the whole template again, in the same format (---LETTER N--- / ---SEGMENT: <when>---).`
  );
}

/**
 * Подсказка повтора шага 2d про чужую компанию в письмах ('us', проверка включена — letterBrandGuard):
 * пункты heBrandLeakFixItems — что убрать и о ком писать вместо этого. Язык —
 * язык генерации ('en' — английский, иначе русский). Идёт отдельным абзацем
 * после подсказки по операторам (если она есть) — её текст не меняется.
 */
function brandLeakRetryHint(leaks: HeBrandLeak[], language: HeChainLanguage, clientCompany: string): string {
  const items = heBrandLeakFixItems(leaks, language, clientCompany).map((i) => `- ${i.detail}`).join('\n');
  return language === 'en'
    ? `The template names a company that is not the sender:\n${items}\n\nFix each item as it says. ` +
        `Return the whole template again, in the same format (---LETTER N--- / ---LETTER 1 B--- / ---SEGMENT: <when>---).`
    : `В шаблоне назван не тот отправитель:\n${items}\n\nИсправь каждый пункт, как в нём сказано. ` +
        `Верни шаблон заново, целиком, в том же формате (---LETTER N--- / ---LETTER 1 B--- / ---SEGMENT: <when>---).`;
}

/** Сколько проблем нашёл гейт отправки — мера «лучше/хуже» для повторов и рерайта. */
function gateIssueCount(gate: HeTemplateOperatorGateResult): number {
  return gate.subjectUnresolved.length + gate.unbacked.length + gate.malformed.length + gate.emptyCells.length;
}

/** Колонки готового шаблона, которые стадия отдаёт при переиспользовании. */
const REUSABLE_TEMPLATE_COLUMNS = 'id, fixed_block, personalization_plan, letters, created_at';

interface HeReusableTemplate {
  id: string;
  fixed_block: string | null;
  personalization_plan: unknown;
  letters: unknown;
  created_at: string;
}

/**
 * Готовый ('ready') шаблон этой базы, который стадия обязана ВЕРНУТЬ, а не
 * собрать заново за новые деньги. Самый свежий.
 *
 * ПЕРЕИСПОЛЬЗОВАНИЕ — ПО ЯВНОЙ ПРОСЬБЕ (payload.reuse === true, с 14.10.2026).
 * Его ставят пути ENG, которым письма поверх готовых не нужны: реконсилер
 * «Launch» (autopilotReconcile.ts), дочейн автопилота после анализа у проекта
 * 'us' (autopilotNext.ts) и роут шаблона кабинета
 * (api/client/eng/bases/[id]/template). С ним — любой готовый шаблон базы:
 * гонка двух постановок и повтор джобы, у которой шаблон уже лёг, а
 * done-запись — нет, не платят за письма, которые уже есть.
 *
 * Без него (джобы staff-инструмента — payload.force, «Rewrite letters»
 * кабинета, который снял готовые письма и ждёт новых, и любая джоба,
 * поставленная кодом до этой правки с payload { base_id }) — только шаблон,
 * созданный не раньше самой джобы: старые шаблоны базы не берутся, и джоба
 * пишет письма заново, как до переиспользования; а свой собственный,
 * вставленный прошлой попыткой этой же джобы (упала done-запись, рестарт пода
 * после вставки), берётся — иначе повтор платил бы генерацию второй раз и
 * оставлял базе второй готовый шаблон. Метки обе от часов БД (default now() у
 * he_templates и he_jobs). force вместе с reuse — побеждает force.
 *
 * Сбой чтения бросаем: «не знаю, есть ли шаблон» — не «шаблона нет», и платная
 * генерация на догадке здесь ровно тот дефект, который чинится.
 *
 * Готовый шаблон, чьи письма называют чужую компанию (`leaksOf` не пуст —
 * letterBrandGuard.heTemplateBrandLeaks: us-проект, клиент не мы, правило
 * языка — шапка letterBrandGuard), не возвращается: такие письма ядро запуска откажет, и вернуть их
 * значило бы не написать новых никогда. Берётся самый свежий без утечки среди
 * последних REUSE_SCAN готовых; нет такого — генерация. Сам шаблон остаётся
 * как есть ('failed' у he_templates пишет только роут «Rewrite letters»).
 */
const REUSE_SCAN = 20;

/** Просит ли джоба вернуть ЛЮБОЙ готовый шаблон базы (см. findReusableTemplate). */
function heTemplateJobReusesAny(job: HeJob): boolean {
  return job.payload?.reuse === true && job.payload?.force !== true;
}

async function findReusableTemplate(
  ctx: HeStageContext,
  job: HeJob,
  baseId: string,
  leaksOf: (letters: unknown) => HeBrandLeak[],
): Promise<HeReusableTemplate | null> {
  let query = ctx.supabase
    .from('he_templates')
    .select(REUSABLE_TEMPLATE_COLUMNS)
    .eq('base_id', baseId)
    .eq('status', 'ready');
  if (!heTemplateJobReusesAny(job)) {
    // Без метки джобы «свой» шаблон от чужого не отличить — тогда собираем
    // заново (воркер клеймит строку целиком, created_at в ней есть всегда;
    // ветка — страховка от неполной строки).
    if (typeof job.created_at !== 'string' || job.created_at.length === 0) return null;
    query = query.gte('created_at', job.created_at);
  }
  const { data, error } = await query.order('created_at', { ascending: false }).limit(REUSE_SCAN);
  if (error) throw new Error(`he_templates reuse read: ${error.message}`);
  for (const row of (data ?? []) as HeReusableTemplate[]) {
    const leaks = leaksOf(row.letters);
    if (leaks.length === 0) return row;
    stageLog(
      ctx,
      `[template] готовый шаблон ${row.id} не переиспользуем: в письмах наш бренд или компания из примера, а клиент проекта — другая компания (${describeHeBrandLeaks(leaks, 3)})`,
    );
  }
  return null;
}

export async function runTemplateStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();
  const baseId = payloadString(job, 'base_id');

  // Рынок проекта решает, что из переноса ENG здесь действует (шапка). Воркер
  // передаёт его всегда (ctx.market); без него — из строки проекта (одно
  // лишнее чтение, только вне воркера).
  const market = ctx.market ?? projectMarket(await readProject(ctx.supabase, job.project_id));

  // Рынок 'us': база — только СВОЕГО проекта: base_id приходит из payload
  // джобы, и без скоупа джоба проекта A строила бы (и оплачивала бы проекту A)
  // шаблон по базе проекта B. У 'ru' чтение — как до переноса ENG.
  let baseQuery = ctx.supabase.from('he_bases').select('*').eq('id', baseId);
  if (market === 'us') baseQuery = baseQuery.eq('project_id', job.project_id);
  const { data: baseRow, error: bError } = await baseQuery.single();
  if (bError || !baseRow) throw new Error(`he_bases ${baseId}: ${bError?.message ?? 'not found'}`);
  const base = baseRow as HeBase;

  // Рынок 'us': пустая база — отказ ДО первого платного вызова: письма по базе
  // без строк запускать некуда (запуск ответит «нет валидных адресов»), а план
  // и письма уже были бы оплачены. У 'ru' — как до переноса ENG (загрузка CSV
  // пустой файл и так не принимает).
  if (market === 'us') {
    const rowCount = typeof base.row_count === 'number' ? base.row_count : 0;
    if (!(rowCount > 0)) {
      throw new Error(`he_bases ${baseId}: в базе нет строк (row_count=${rowCount}) — шаблон по пустой базе не собираем`);
    }
  }

  // Проект — до переиспользования: готовый шаблон, чьи письма называют чужую
  // компанию, стадия не возвращает (findReusableTemplate), а решает это хост
  // сайта и бриф проекта. Строки проекта нет — база ушла вместе с ним
  // (he_bases.project_id on delete cascade), и чтение базы выше уже упало.
  const project = await readProject(ctx.supabase, job.project_id);
  // Владелец проекта — клиент ENG-кабинета (letterBrandGuard.heEngClient): его
  // письма проверяются на любом языке. Одно чтение профиля на джобу 'us'.
  const brandProject = {
    ...project,
    heEngClient: market === 'us' ? await readHeBrandEngClient(ctx.supabase, project.created_by) : false,
  };
  const reusable = await findReusableTemplate(ctx, job, baseId, (letters) =>
    heTemplateBrandLeaks(market, brandProject, letters),
  );
  if (reusable) {
    stageLog(
      ctx,
      `[template] у базы уже есть готовый шаблон ${reusable.id} — возвращаем его, модель не зовём` +
        (heTemplateJobReusesAny(job) ? '' : ' (его вставила прошлая попытка этой же джобы)'),
    );
    return {
      result: {
        template_id: reusable.id,
        reused: true,
        fixed_block: reusable.fixed_block,
        personalization_plan: reusable.personalization_plan,
        letters: reusable.letters,
      },
      tokensUsed: 0,
      costUsd: 0,
    };
  }

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
  // styleExample в промпты плана и финальных писем. Подпись отправителя
  // (signature_override) → signatureOverride в план, письма и рерайт.
  const brief = (project.brief ?? {}) as Record<string, unknown>;
  const styleExample = typeof brief.style_override === 'string' ? brief.style_override : undefined;
  const signatureOverride =
    typeof brief.signature_override === 'string' ? brief.signature_override : undefined;
  // Слова клиента (offer_override, business_override) — в план, письма, критик
  // и рерайт. Блок «CLIENT'S OWN WORDS» сборщики рендерят только у английских
  // писем проекта 'us': RU/PL-промпты и английские промпты проекта 'ru' то же
  // поле игнорируют и не меняются.
  const clientWords = clientWordsFromBrief(brief);

  // Winner-паттерны датасета (best-effort): метки сегментов по терминам
  // вертикали (имя + синонимы), фолбэк хинтов — имя вертикали. Любой сбой →
  // генерим без паттернов, стадию это не валит.
  // Рынок обязателен (market — выше, у переиспользования): словарь
  // SEGMENT_LABEL_KEYWORDS содержит и английские токены (saas, logistics,
  // retail), поэтому ENG-вертикаль матчится на RU-сегменты, и в английскую
  // генерацию уезжают русские темы кампаний вместе с русским текстом самого
  // блока (renderWinnerPatternsBlock).
  let winnerPatterns: HeWinnerPattern[] = [];
  try {
    const terms = [vertical.name, ...(Array.isArray(vertical.synonyms) ? vertical.synonyms : [])];
    const labels = matchSegmentLabels(terms);
    winnerPatterns = await getWinnerPatterns(labels.length ? labels : [vertical.name], 5, { market });
  } catch (e) {
    stageLog(ctx, `[template] winner-паттерны датасета недоступны: ${e instanceof Error ? e.message : String(e)}`);
  }

  const columns = Array.isArray(base.columns) ? base.columns : [];

  // Только 'us': строки базы и колонка адреса — вход гейта отправки (шаг 3b и
  // его предсказание на шагах 2d/2e). RU их не читает.
  const baseRows =
    market === 'us' && Array.isArray(base.data) ? (base.data as Array<Record<string, unknown>>) : [];
  const emailColumn = market === 'us' ? findEmailColumn(columns, baseRows) : null;
  // Только 'us': колонку, пустую хотя бы у одного адреса и без замены по виду
  // (vacancy_title, phone, address, …), гейт отправки откажет (пустая ячейка
  // без замены), и платная генерация ушла бы в отказ при каждом повторе. Модель
  // плана таких колонок не видит; маппинг и гейт по-прежнему считают по всем.
  const hiddenColumns = market === 'us' ? heColumnsWithoutStandIn({ columns, rows: baseRows, emailColumn }) : [];
  const planColumns = hiddenColumns.length ? columns.filter((c) => !hiddenColumns.includes(c)) : columns;
  if (hiddenColumns.length) {
    stageLog(
      ctx,
      `[template] колонки с пустыми ячейками у адресов и без замены не показываем модели плана: ${hiddenColumns.join(', ')}`,
    );
  }

  // Язык всех промптов стадии наследуется от цепочки вертикали (he_chains.language).
  const language = (chain.language === 'en' || chain.language === 'pl' ? chain.language : 'ru') as HeChainLanguage;
  // Английские письма проекта 'us' — всё, что перенос ENG поменял в письмах;
  // иначе (RU, PL и английские письма проекта 'ru') — как до переноса.
  const usEnglish = heUsEnglishLetters(language, market);

  // Письма 'us': чужая компания в письмах (letterBrandGuard). Список не пуст,
  // только когда клиент подтверждённо не мы (хост сайта проекта не наш) и
  // письма английские или польские — или владелец клиент ENG-кабинета (тогда и
  // русские). RU и наш собственный проект — пустой список всегда.
  const brandGuard = heLetterBrandGuard(market, brandProject, language);
  const brandLeaksOf = (ls: HeChainLetterAB[]): HeBrandLeak[] => heLetterBrandLeaks(brandGuard, ls);
  // Наш бренд в поле брифа, которое промпт берёт дословно: письма с ним не
  // пройдут проверку ни в одном прогоне — отказ до первого платного вызова (план).
  const brandInputs = heBrandInputLeaks(brandGuard, brief);
  if (brandInputs.length) {
    stageLog(
      ctx,
      `[template] поле брифа называет наш бренд, а клиент проекта — другая компания: генерацию не начинаем — ${describeHeBrandInputLeaks(brandInputs)}`,
    );
    throw new HeLetterBrandInputError('template', brandInputs);
  }

  // Шаг 1: план 85/15.
  const plan = await callLLMWithSchema(
    buildTemplatePlanMessages({
      language,
      market,
      verticalName: vertical.name,
      verticalSummary: vertical.summary ?? '',
      chainLetters,
      baseAnalysis: analysis,
      columns: planColumns,
      hypotheses,
      clientCase,
      styleExample,
      signatureOverride,
      clientWords,
    }),
    HeTemplatePlanSchema,
    { model: getHeModel('chain'), maxTokens: 8192 },
  );
  addUsage(usage, plan);

  // Шаг 2: финальные письма по плану.
  const model = getHeModel('chain');
  const messages = buildTemplateLettersMessages({
    language,
    market,
    plan: plan.data,
    verticalName: vertical.name,
    chainLetters,
    baseAnalysis: analysis,
    clientCase,
    styleExample,
    winnerPatterns,
    signatureOverride,
    clientWords,
  });

  /** Сырой ответ модели → письма с приклеенными сегментными и B-вариантами. */
  const buildLetters = (raw: string): { parsed: ParsedLetter[]; letters: HeChainLetterAB[] } => {
    // Сначала B-варианты (---LETTER 1 B---), затем сегментные блоки: оба
    // сплиттера работают до letterParser, который про эти маркеры не знает.
    const ab = extractLetterBVariants(raw);
    const seg = extractSegmentVariants(ab.cleaned);
    const parsed = parseLettersFromModelOutput(seg.cleaned);
    const sliced = parsed.slice(0, TEMPLATE_MAX_LETTERS);
    // wait_days — лесенка цепочки CHAIN_WAIT_DAYS (внутри parsedToChainLetters), по индексу письма;
    // у 'us' перед записью её заменяют паузы цепочки (applyHeChainTiming ниже).
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

  let llm = await callLLMTextWithFallback(messages, { model, maxTokens: 16384, log: (m) => stageLog(ctx, m) });
  addUsage(usage, llm);
  let { parsed, letters } = buildLetters(llm.text);

  // Английские письма 'us': шаблон не имеет права укоротить цепочку. Цель — число писем
  // he_chains.letters (их клиент видел и правил на шаге Letters; второго
  // источника числа нет), не больше того, что стадия берёт вообще. Писем меньше
  // цели → тот же ОДИН повтор, что и при < 3, с английской подсказкой; из двух
  // ответов — ближайший к цели, но не меньше 3 (ничья — повтор). Отказа «по
  // длине» нет: стадия падает, только если и после повтора меньше 3 писем, как
  // раньше. RU/PL и английские письма проекта 'ru' — прежний порог < 3 и
  // русская подсказка.
  const targetLetters = Math.min(chainLetters.length, TEMPLATE_MAX_LETTERS);
  const retryBelow = usEnglish ? Math.max(TEMPLATE_MIN_LETTERS, targetLetters) : TEMPLATE_MIN_LETTERS;
  if (parsed.length < retryBelow) {
    stageLog(
      ctx,
      usEnglish
        ? `[template] распознано ${parsed.length} писем, в цепочке ${targetLetters} — retry с фидбэком`
        : `[template] распознано ${parsed.length} писем — retry с фидбэком`,
    );
    const first = { llm, parsed, letters };
    const retryMessages: LLMMessage[] = [
      ...messages,
      { role: 'assistant', content: llm.text.slice(0, 2000) },
      { role: 'user', content: usEnglish ? lengthRetryHintEn(targetLetters, parsed.length) : RETRY_HINT },
    ];
    llm = await callLLMTextWithFallback(retryMessages, { model, maxTokens: 16384, log: (m) => stageLog(ctx, m) });
    addUsage(usage, llm);
    ({ parsed, letters } = buildLetters(llm.text));
    if (
      usEnglish &&
      letterCountDistance(first.letters.length, targetLetters) < letterCountDistance(letters.length, targetLetters)
    ) {
      stageLog(
        ctx,
        `[template] повтор вернул ${letters.length} писем — оставляем первый ответ (${first.letters.length}), он ближе к ${targetLetters}`,
      );
      ({ llm, parsed, letters } = first);
    }
  }
  if (parsed.length < 3) {
    throw new Error(`Шаблон не распарсился: ${parsed.length} писем после retry`);
  }
  if (usEnglish && letters.length !== targetLetters) {
    stageLog(ctx, `[template] писем в шаблоне ${letters.length}, в цепочке ${targetLetters} — число писем расходится`);
  }

  // Шаг 2b: длина тел — регламент ≤80 слов (письмо 1 ≤70); >85 слов → один retry на сокращение.
  // Английские письма 'us': сокращённый ответ не принимается, если он дальше от числа писем цепочки.
  if (letters.some((l) => countWords(l.body) > SHORTEN_RETRY_WORDS)) {
    stageLog(ctx, '[template] тела писем длиннее регламента — retry на сокращение');
    const retryLlm = await callLLMText(
      [
        ...messages,
        { role: 'assistant', content: llm.text.slice(0, 2000) },
        { role: 'user', content: shortenRetryHint(letters, usEnglish) },
      ],
      { model, maxTokens: 16384 },
    );
    addUsage(usage, retryLlm);
    const rebuilt = buildLetters(retryLlm.text);
    const keepsLength =
      !usEnglish ||
      letterCountDistance(rebuilt.letters.length, targetLetters) <= letterCountDistance(letters.length, targetLetters);
    if (rebuilt.parsed.length >= 3 && keepsLength) {
      llm = retryLlm;
      ({ parsed, letters } = rebuilt);
    } else if (rebuilt.parsed.length >= 3) {
      stageLog(
        ctx,
        `[template] сокращённый вариант: ${rebuilt.letters.length} писем вместо ${letters.length} (в цепочке ${targetLetters}) — оставляем исходные письма`,
      );
    } else {
      stageLog(ctx, '[template] сокращённый вариант не распарсился — оставляем исходные письма');
    }
  }

  // Шаг 2c: детерминированный контроль регламента + фактчек цифр (letterChecks).
  // Тире/приветствие/один CTA/стоп-фразы + числа только из материалов (анализ
  // базы, цепочка, кейс, бриф, winner-паттерны, fixed_block). Варианты A и B
  // проверяются полностью; сегментные варианты — только по числам (это
  // фрагменты, без приветствия/CTA). Нарушения → один фикс-проход ДО маппинга
  // операторов и критика: критик должен ревьюить финальную механику текста.
  const factCorpus = [
    JSON.stringify(analysis),
    chainLetters.map((l) => `${l.subject ?? ''}\n${l.body}`).join('\n'),
    vertical.name,
    vertical.summary ?? '',
    clientCase ? JSON.stringify(clientCase) : '',
    JSON.stringify(brief),
    JSON.stringify(winnerPatterns),
    plan.data.fixed_block,
    // Английские письма 'us': слова клиента сырым текстом. Внутри JSON брифа
    // выше они уже есть; здесь — чтобы цифры клиента, которые их промпт велит
    // цитировать дословно, оставались в корпусе, даже если бриф из него
    // когда-то уберут (стадия chain у них так и сделала). Остальные — корпус прежний.
    ...(usEnglish ? [clientWords.offerOverride ?? '', clientWords.businessOverride ?? ''] : []),
  ].join('\n');
  // Чтение чисел: английские письма 'us' — запятая разделяет тысячи
  // (letterChecks); остальные — прежнее чтение. Письма сверяются так же, как
  // прочитан корпус.
  const facts = extractNumberFacts(factCorpus, language, market);
  // letterIndex — номер письма в detail нарушения (учитывается только у английских писем 'us').
  const lettersForCheck = (ls: HeChainLetterAB[]): HeLetterForCheck[] =>
    ls.flatMap((l, i) => [
      { subject: l.subject ?? '', body: l.body, variant: 'A', letterIndex: i + 1 },
      ...(l.variants ?? []).map((v) => ({ subject: v.subject ?? '', body: v.body, variant: 'B', letterIndex: i + 1 })),
    ]);
  const segmentNumberViolations = (ls: HeChainLetterAB[]): HeLetterRuleViolation[] =>
    ls.flatMap((l, i) =>
      (l.segment_variants ?? []).flatMap((sv) =>
        findUnverifiedNumbers(sv.text, facts).map((token) => ({
          letter: i + 1,
          rule: 'unverified_number' as const,
          detail:
            usEnglish
              ? `letter ${i + 1}, segment variant: the number "${token}" is not in the materials; remove it or replace it with a figure from the materials`
              : `письмо ${i + 1}, сегментный вариант: число «${token}» отсутствует в материалах — удали или замени фактом из материалов`,
        })),
      ),
    );
  const collectRuleViolations = (ls: HeChainLetterAB[]) => [
    ...checkLetterRules(lettersForCheck(ls), language, facts, market),
    ...segmentNumberViolations(ls),
  ];
  /** Сколько нарушений — числа не из материалов (unverified_number). */
  const unverifiedCount = (violations: HeLetterRuleViolation[]) =>
    violations.filter((v) => v.rule === 'unverified_number').length;
  const ruleViolations = collectRuleViolations(letters);
  // 'us', проверка включена (letterBrandGuard): чужая компания в письмах клиента (brandLeaksOf; иначе пусто) запускает
  // этот же фикс-проход своими пунктами — без него шаг 3b шаблон не запишет.
  const brandLeaksBeforeFix = brandLeaksOf(letters);
  if (ruleViolations.length > 0 || brandLeaksBeforeFix.length > 0) {
    stageLog(
      ctx,
      `[template] детерминированный контроль: ${ruleViolations.length} нарушений${
        brandLeaksBeforeFix.length ? `, чужая компания в письмах: ${describeHeBrandLeaks(brandLeaksBeforeFix)}` : ''
      } — фикс-проход`,
    );
    // Принятие фикса: то же число писем и не меньше B/сегментных вариантов
    // (модель могла молча выкинуть блоки ---LETTER N B--- / ---SEGMENT---).
    // Английские письма 'us' — и не больше непроверенных чисел, чем в письмах до него: фикс
    // переписывает шаблон целиком и мог вписать цифру, которой нет в
    // материалах, а повтор и рерайт ниже сравнивают числа уже с письмами
    // после фикса — такая цифра ушла бы получателю (rule_violations — только
    // предупреждение). 'us', проверка включена — и не больше упоминаний чужой компании, чем до
    // него. Вызов фикса уже оплачен; новых вызовов нет.
    const countVariants = (ls: HeChainLetterAB[]) => ({
      b: ls.reduce((acc, l) => acc + (l.variants?.length ?? 0), 0),
      seg: ls.reduce((acc, l) => acc + (l.segment_variants?.length ?? 0), 0),
    });
    const before = countVariants(letters);
    try {
      const fix = await callLLMText(
        [
          ...messages,
          { role: 'assistant', content: llm.text },
          {
            role: 'user',
            content: buildChainRuleFixHint(
              [...ruleViolations, ...heBrandLeakFixItems(brandLeaksBeforeFix, language, brandGuard.clientCompany)],
              language,
              { hasSegmentBlocks: true },
            ),
          },
        ],
        { model, maxTokens: 16384 },
      );
      addUsage(usage, fix);
      const rebuilt = buildLetters(fix.text);
      const after = countVariants(rebuilt.letters);
      if (
        rebuilt.parsed.length >= 3 &&
        rebuilt.letters.length === letters.length &&
        after.b >= before.b &&
        after.seg >= before.seg
      ) {
        const remaining = collectRuleViolations(rebuilt.letters);
        const numbersBefore = usEnglish ? unverifiedCount(ruleViolations) : 0;
        const numbersAfter = usEnglish ? unverifiedCount(remaining) : 0;
        const brandAfterFix = brandLeaksOf(rebuilt.letters);
        if (numbersAfter > numbersBefore) {
          stageLog(
            ctx,
            `[template] фикс-проход: непроверенных чисел ${numbersAfter} (было ${numbersBefore}) — оставляем исходные письма; ${remaining
              .filter((v) => v.rule === 'unverified_number')
              .slice(0, 3)
              .map((v) => v.detail)
              .join('; ')}`,
          );
        } else if (brandAfterFix.length > brandLeaksBeforeFix.length) {
          stageLog(
            ctx,
            `[template] фикс-проход: чужая компания в письмах ${brandAfterFix.length} раз (было ${brandLeaksBeforeFix.length}) — оставляем исходные письма; ${describeHeBrandLeaks(brandAfterFix, 3)}`,
          );
        } else {
          llm = fix;
          parsed = rebuilt.parsed;
          letters = rebuilt.letters;
          if (remaining.length > 0) {
            stageLog(
              ctx,
              `[template] после фикс-прохода осталось ${remaining.length} нарушений: ${remaining
                .slice(0, 3)
                .map((v) => v.detail)
                .join('; ')}`,
            );
          }
          if (brandAfterFix.length > 0) {
            stageLog(ctx, `[template] после фикс-прохода чужая компания в письмах осталась: ${describeHeBrandLeaks(brandAfterFix)}`);
          }
        }
      } else {
        stageLog(
          ctx,
          `[template] фикс-проход: ${rebuilt.parsed.length} писем, варианты ${after.b}B/${after.seg}seg вместо ${before.b}B/${before.seg}seg — оставляем исходные`,
        );
      }
    } catch (e) {
      stageLog(ctx, `[template] фикс-проход недоступен: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Шаг 2d: операторы финальных писем → колонки базы (pure) + консистентность.
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

  // Гейт отправки 'us' (шаг 3b) по любым письмам — ровно та цепочка, что перед
  // записью: маппинг → бесплатная починка приветствия (и маппинг заново) →
  // замены пустых ячеек → checkHeTemplateOperators по строкам с адресом.
  // Чистая функция, без модели: шаги 2d и 2e зовут её, чтобы заранее знать,
  // откажет ли гейт, а шаг 3b — для самого решения.
  const sendGate = (ls: HeChainLetterAB[]) => {
    let sentOps = collectOperators(ls);
    let mapping = buildMapping(sentOps.allOperators);
    const repaired = repairHeNameGreetings(ls, columns, mapping);
    if (repaired.repairs.length) {
      sentOps = collectOperators(repaired.letters);
      mapping = buildMapping(sentOps.allOperators);
    }
    const withStandIns = withHeEmptyCellFallbacks(mapping, columns).mapping;
    const gate = checkHeTemplateOperators({
      letters: repaired.letters,
      columns,
      operatorMapping: withStandIns,
      rows: baseRows,
      emailColumn,
    });
    return { letters: repaired.letters, repairs: repaired.repairs, ops: sentOps, mapping, withStandIns, gate };
  };

  // Чем письма повтора по операторам (шаг 2d) хуже писем до него — бесплатно,
  // по детерминированным проверкам; null — принять новые письма. Рерайт
  // критика (шаг 2e) судится своим, более узким правилом
  // (rewriteRollbackReason). Порядок:
  //  0) 'us', проверка включена — чужая компания в письмах (brandLeaksOf; иначе 0). Такой же провал
  //     шага 3b, как гейт: повтор, после которого упоминаний больше, — откат;
  //     меньше — принимаем, если только повтор не сломал гейт (п. 1) и не
  //     добавил непроверенных чисел — то же правило, что у гейта.
  //  1) 'us' — гейт отправки. Провал на шаге 3b стоит всей оплаченной
  //     генерации, поэтому письма, которые он пропускает, лучше: проходил до и
  //     не проходит после — откат; не проходил и проходит — принимаем, если
  //     только повтор не добавил непроверенных чисел (письмо не должно
  //     утверждать того, чего нет в материалах); не проходит ни там, ни там —
  //     откат, если проблем гейта больше.
  //  2) регламент — collectRuleViolations (letterChecks + числа сегментных
  //     вариантов; абзацы сюда НЕ входят: они только предупреждение).
  //     Английские письма 'us': сначала непроверенные числа (их больше —
  //     откат, даже если всего нарушений столько же или меньше; меньше —
  //     принимаем), затем общее число; остальные — общее число, как раньше.
  type LetterStanding = {
    gate: HeTemplateOperatorGateResult | null;
    /** Упоминаний чужой компании (только когда проверка включена — letterBrandGuard; иначе 0). */
    brand: number;
    rules: number;
    numbers: number;
  };
  const standingOf = (ls: HeChainLetterAB[], gate: HeTemplateOperatorGateResult | null): LetterStanding => {
    const violations = collectRuleViolations(ls);
    return {
      gate,
      brand: brandLeaksOf(ls).length,
      rules: violations.length,
      numbers: unverifiedCount(violations),
    };
  };
  const lettersStanding = (ls: HeChainLetterAB[]) => standingOf(ls, market === 'us' ? sendGate(ls).gate : null);
  type LettersRegression =
    | { kind: 'gate'; was: number; now: number }
    | { kind: 'brand'; was: number; now: number }
    | { kind: 'numbers'; was: number; now: number }
    | { kind: 'rules'; was: number; now: number };
  const lettersRegression = (before: LetterStanding, after: LetterStanding): LettersRegression | null => {
    const numbersUp = after.numbers > before.numbers;
    if (after.brand > before.brand) return { kind: 'brand', was: before.brand, now: after.brand };
    if (before.gate && after.gate && before.gate.ok !== after.gate.ok) {
      if (before.gate.ok) return { kind: 'gate', was: 0, now: gateIssueCount(after.gate) };
      return numbersUp ? { kind: 'numbers', was: before.numbers, now: after.numbers } : null;
    }
    if (before.gate && after.gate && !after.gate.ok) {
      const was = gateIssueCount(before.gate);
      const now = gateIssueCount(after.gate);
      if (now > was) return { kind: 'gate', was, now };
    }
    if (after.brand < before.brand) {
      return numbersUp ? { kind: 'numbers', was: before.numbers, now: after.numbers } : null;
    }
    if (usEnglish && after.numbers !== before.numbers) {
      return numbersUp ? { kind: 'numbers', was: before.numbers, now: after.numbers } : null;
    }
    return after.rules > before.rules ? { kind: 'rules', was: before.rules, now: after.rules } : null;
  };

  let ops = collectOperators(letters);
  let operatorMapping = buildMapping(ops.allOperators);
  let mappingIssues = validateOperatorMapping(operatorMapping, columns, plan.data, {
    subjectOperators: ops.subjectOperators,
  });

  // 'us': откажет ли этим письмам гейт отправки — бесплатно, ДО платного
  // повтора. Отказ гейта тоже запускает этот (единственный) повтор, и его
  // описание идёт в подсказку: иначе детерминированную причину (оператор в
  // начале предложения, колонка без замены) модель повторяла бы в каждой
  // следующей платной генерации, и шаблон не лёг бы ни разу. RU — как раньше.
  const gateBeforeRetry = market === 'us' ? sendGate(letters).gate : null;
  const refusingGate = gateBeforeRetry && !gateBeforeRetry.ok ? gateBeforeRetry : null;
  // 'us', проверка включена (letterBrandGuard): чужая компания, которую фикс-проход (шаг 2c) не снял, запускает тот же
  // единственный повтор, со своим абзацем подсказки: иначе шаг 3b шаблон не
  // запишет, и воркер купит всю генерацию заново. RU — пустой список.
  const brandBeforeRetry = brandLeaksOf(letters);

  if (mappingIssues.length || refusingGate || brandBeforeRetry.length) {
    if (mappingIssues.length) {
      stageLog(ctx, `[template] operator_mapping: ${mappingIssues.length} проблем — retry с фидбэком`);
    }
    if (refusingGate) {
      stageLog(
        ctx,
        `[template] гейт отправки отказал бы этим письмам — retry с фидбэком: ${describeHeTemplateOperatorGate(refusingGate, 6)}`,
      );
    }
    if (brandBeforeRetry.length) {
      stageLog(ctx, `[template] чужая компания в письмах — retry с фидбэком: ${describeHeBrandLeaks(brandBeforeRetry)}`);
    }
    // Принимаем регенерацию только с тем же числом писем и не хуже прежней
    // (lettersRegression, с регламентом): retry переписывает шаблон целиком и
    // мог вернуть тире/лишние CTA уже после фикс-прохода, а у 'us' — сломать
    // гейт отправки или вписать чужую компанию.
    const preRetryStanding = standingOf(letters, gateBeforeRetry);
    const preRetry = { letters, ops, operatorMapping, mappingIssues };
    const operatorHint =
      mappingIssues.length || refusingGate
        ? usEnglish
          ? operatorIssuesHintEn([
              ...validateOperatorMapping(operatorMapping, columns, plan.data, {
                subjectOperators: ops.subjectOperators,
                language,
              }),
              ...(refusingGate ? heTemplateOperatorGateProblemsEn(refusingGate) : []),
            ])
          : operatorIssuesHint(
              refusingGate ? [...mappingIssues, describeHeTemplateOperatorGate(refusingGate, 12)] : mappingIssues,
            )
        : '';
    const brandHint = brandBeforeRetry.length
      ? brandLeakRetryHint(brandBeforeRetry, language, brandGuard.clientCompany)
      : '';
    const hint = [operatorHint, brandHint].filter(Boolean).join('\n\n');
    const retryLlm = await callLLMText(
      [
        ...messages,
        { role: 'assistant', content: llm.text.slice(0, 2000) },
        { role: 'user', content: hint },
      ],
      { model, maxTokens: 16384 },
    );
    addUsage(usage, retryLlm);
    const rebuilt = buildLetters(retryLlm.text);
    if (rebuilt.parsed.length >= 3 && rebuilt.letters.length === letters.length) {
      const worse = lettersRegression(preRetryStanding, lettersStanding(rebuilt.letters));
      if (worse) {
        stageLog(
          ctx,
          worse.kind === 'rules'
            ? `[template] retry по операторам вернул ${worse.now} нарушений регламента (было ${worse.was}) — оставляем прежние письма`
            : worse.kind === 'numbers'
              ? `[template] retry по операторам вернул ${worse.now} непроверенных чисел (было ${worse.was}) — оставляем прежние письма`
              : worse.kind === 'brand'
                ? `[template] retry по операторам: чужая компания в письмах ${worse.now} раз (было ${worse.was}) — оставляем прежние письма`
                : `[template] retry по операторам: гейт отправки нашёл ${worse.now} проблем (было ${worse.was}) — оставляем прежние письма`,
        );
        ({ letters, ops, operatorMapping, mappingIssues } = preRetry);
      } else {
        llm = retryLlm;
        letters = rebuilt.letters;
        ops = collectOperators(letters);
        operatorMapping = buildMapping(ops.allOperators);
        mappingIssues = validateOperatorMapping(operatorMapping, columns, plan.data, {
          subjectOperators: ops.subjectOperators,
        });
      }
    } else {
      stageLog(ctx, '[template] retry по операторам не распарсился/сменил число писем — оставляем предыдущие письма');
    }
  }

  // Шаг 2e: критик-луп — одна оценка финальных писем той же моделью, что и
  // генерация (getHeModel('chain')), + максимум один rewrite по её замечаниям.
  // Критик работает ТОЛЬКО по основному варианту A (B-вариант и сегментные
  // варианты в разбор не идут — стоимость). Rewrite не содержит ---SEGMENT---
  // и ---LETTER N B--- блоков: варианты после его принятия восстанавливаются
  // из исходных писем по индексу. Без цикла; сбой критика, нечитаемый,
  // урезанный или раздутый rewrite → остаются исходные письма. Критик идёт
  // ПОСЛЕ фикс-прохода и маппинга операторов — он ревюит финальную механику
  // текста; маппинг после рерайта пересобирается детерминированно (ниже).
  // Английские письма 'us': критик и рерайт видят «CLIENT'S OWN WORDS»
  // (clientWords; сборщики читают поле только у них) — чтобы критик сверял
  // сказанное о клиенте с его словами, а рерайт брал конкретику оттуда, а не
  // выдумывал.
  //
  // Фикс-проход был до рерайта, а сам рерайт регламент не проходит. Поэтому
  // рерайт сверяется с письмами до него — бесплатно, детерминированными
  // проверками — и откатывается (сам он уже оплачен) только в трёх случаях:
  //  а) 'us': гейт отправки письма до него пропускал, а после него — нет
  //     (провал на шаге 3b стоил бы всей оплаченной генерации);
  //  а′) 'us', проверка включена (letterBrandGuard): упоминаний чужой компании (brandLeaksOf) после него больше, чем
  //     до него — тот же провал шага 3b;
  //  б) английские письма 'us': чисел не из материалов (unverified_number, с сегментными
  //     вариантами) стало больше — письмо не должно утверждать того, чего нет
  //     в материалах.
  // Тире, приветствие, «?», стоп-фразы, абзацы и гейт, который не пропускает
  // письма ни до рерайта, ни после (шаг 3b шаблон тогда не запишет при любом
  // выборе), рерайт не откатывают: критик — единственная проверка писем по
  // смыслу (обещание без опоры, утверждение о рынке получателя, которого
  // отправитель знать не может), и откат за стиль выбросил бы его правки.
  // Нарушения регламента принятого рерайта ложатся в
  // personalization_plan.rule_violations (ниже). Рынок 'ru' (любой язык, и
  // английский тоже) — как до переноса ENG: рерайт той же длины принимается.
  const rewriteRollbackReason = (before: HeChainLetterAB[], after: HeChainLetterAB[]): string | null => {
    if (market !== 'us') return null;
    if (market === 'us' && sendGate(before).gate.ok) {
      const gateAfter = sendGate(after).gate;
      if (!gateAfter.ok) {
        return `гейт отправки письма до него пропускал, после него — ${gateIssueCount(gateAfter)} проблем`;
      }
    }
    if (market === 'us') {
      const was = brandLeaksOf(before).length;
      const now = brandLeaksOf(after);
      if (now.length > was) return `чужая компания в письмах ${now.length} раз (было ${was}): ${describeHeBrandLeaks(now, 3)}`;
    }
    if (usEnglish) {
      const was = unverifiedCount(collectRuleViolations(before));
      const now = unverifiedCount(collectRuleViolations(after));
      if (now > was) return `непроверенных чисел ${now} (было ${was})`;
    }
    return null;
  };
  let critiqueInfo: { verdict: string; issues_count: number; rewritten: boolean } | null = null;
  // Английские письма 'us': замечания критика, чей рерайт откатили, — письма ушли в шаблон без
  // его правки. Ложатся в rule_violations (staff-экран шаблона), иначе
  // помеченная критиком неправда уходила бы молча (только строка лога).
  let rolledBackCriticIssues: HeLetterRuleWarning[] = [];
  try {
    const criticLetters = letters.map((l) => ({ subject: l.subject ?? '', body: l.body }));
    const critique = await callLLMWithSchema(
      buildTemplateCriticMessages({
        verticalName: vertical.name,
        verticalSummary: vertical.summary ?? '',
        letters: criticLetters,
        language,
        market,
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
        buildTemplateRewriteMessages({
          verticalName: vertical.name,
          letters: criticLetters,
          critique: { ...critique.data, issues },
          language,
          market,
          styleExample,
          winnerPatterns,
          signatureOverride,
          clientWords,
        }),
        { model, maxTokens: 16384 },
      );
      addUsage(usage, rewrite);
      const rebuilt = buildLetters(rewrite.text);
      // Принимаем rewrite только при точном совпадении числа писем: иначе
      // ломаются лесенка wait_days и индексация сегментных вариантов.
      if (rebuilt.parsed.length === letters.length) {
        // Рерайт выводит только тему+тело основного варианта (---SEGMENT--- и
        // ---LETTER N B--- блоков в нём нет): варианты восстанавливаем
        // детерминированно из исходных писем по индексу.
        const originalLetters = letters;
        const rewritten = rebuilt.letters.map((l, i): HeChainLetterAB => {
          const orig = originalLetters[i];
          return {
            ...l,
            ...(orig?.segment_variants?.length ? { segment_variants: orig.segment_variants } : {}),
            ...(orig?.variants?.length ? { variants: orig.variants } : {}),
          };
        });
        const rollback = rewriteRollbackReason(originalLetters, rewritten);
        if (rollback) {
          stageLog(ctx, `[template] rewrite критика откатили к письмам до него: ${rollback}`);
          if (usEnglish) {
            rolledBackCriticIssues = issues.map((i) => ({
              rule: 'critic' as const,
              letter: i.letter_index,
              detail: `letter ${i.letter_index}: the critic flagged "${i.problem}", but its rewrite was not used`,
            }));
          }
        } else {
          llm = rewrite;
          parsed = rebuilt.parsed;
          letters = rewritten;
          critiqueInfo.rewritten = true;
        }
      } else {
        stageLog(ctx, `[template] rewrite критика: ${rebuilt.parsed.length} писем вместо ${letters.length} — оставляем исходные`);
      }
    }
  } catch (e) {
    stageLog(ctx, `[template] критик-луп недоступен: ${e instanceof Error ? e.message : String(e)} — оставляем исходные письма`);
  }

  // Шаг 3: после рерайта критика текст мог изменить {{var}} — пересобираем
  // маппинг детерминированно (pure, без LLM-retry: критик уже закрыл смысл).
  ops = collectOperators(letters);
  operatorMapping = buildMapping(ops.allOperators);
  mappingIssues = validateOperatorMapping(operatorMapping, columns, plan.data, {
    subjectOperators: ops.subjectOperators,
  });
  if (mappingIssues.length) {
    stageLog(ctx, `[template] operator_mapping issues (best effort): ${mappingIssues.join(' | ')}`);
  }

  // Шаг 3b: гейт отправки — ТОЛЬКО рынок 'us' (ENG-кабинет). RU-инструмент
  // ведёт специалист: он видит дыры маппинга и правит сам, поэтому для 'ru'
  // этот блок не исполняется вовсе — письма, маппинг и статус прежние.
  //
  // Сначала бесплатная починка строки приветствия: оператор с именем человека
  // без колонки (в ENG-базах её нет никогда) убирается из первой строки тела —
  // «Hello {{firstName}},» → «Hello,». Маппинг после неё пересобирается: он
  // обязан описывать те письма, которые ляжут в he_templates.
  //
  // Что осталось без данных — оператор в отправляемой теме без колонки, оператор
  // без колонки и fallback, битый {{…}} — ушло бы получателю пустотой
  // («Hello ,», «Quick question about »). Такой шаблон НЕ пишется ни в каком
  // статусе (he_templates.status: 'draft' | 'ready' | 'failed'). Строку
  // НЕ-ready шаблона кабинет и автопилот читают как «шаблон есть»: шаг Bases
  // пишет про неё «Template is being built…», а автопилот, кнопка «Start
  // outreach» и клиентский роут шаблона базе с любой строкой шаблона новой
  // генерации не ставят — письма встали бы навсегда. Провал БЕЗ строки — уже
  // разобранный ими путь «письма не собрались»: «template build failed» в
  // ленте, повтор кнопкой и тормоз писем. Ошибка не терминальная: воркер
  // повторит стадию новой генерацией (MAX_ATTEMPTS), и каждый прогон засчитан
  // тормозу писем (heTemplateGenerationBudget).
  if (market === 'us') {
    // Цепочка гейта — sendGate (выше): маппинг этих писем (тот же, что шаг 3
    // только что собрал) → починка приветствия → маппинг заново → замены.
    const sent = sendGate(letters);
    if (sent.repairs.length) {
      letters = sent.letters;
      stageLog(
        ctx,
        `[template] приветствие без имени (колонки с именем в базе нет): ${sent.repairs
          .map((r) => `письмо ${r.letter} ${r.variant}: «${r.before.trim()}» → «${r.after.trim()}»`)
          .join('; ')}`,
      );
      ops = sent.ops;
      mappingIssues = validateOperatorMapping(sent.mapping, columns, plan.data, {
        subjectOperators: ops.subjectOperators,
      });
    }
    // Пустые ячейки колонок (templateOperatorGate, «ПУСТАЯ ЯЧЕЙКА»): каждому
    // оператору с колонкой — замена по виду колонки из закрытой карты, и она
    // ложится в operator_mapping. Так её получают ВСЕ, кто строит лидов по
    // маппингу шаблона: запуск, ночной долив и перенос (mapBaseRowsToLeads —
    // пустая ячейка → fallback). Гейт смотрит строки базы с адресом: пустую
    // ячейку без замены или с заменой не к месту получатель прочёл бы
    // неверно — такой шаблон не пишется, как и прочие провалы гейта.
    operatorMapping = sent.withStandIns;
    const gate = sent.gate;
    if (gate.standIns.length) {
      stageLog(
        ctx,
        `[template] пустые ячейки закрыты заменой: ${gate.standIns
          .map((u) => `{{${u.operator}}} → «${u.standIn}» (пусто у ${u.emptyRows} из ${u.rows} строк с адресом)`)
          .join('; ')}`,
      );
    }
    // Наш бренд или компания из примера в английских письмах, а клиент
    // подтверждённо не мы (letterBrandGuard) — такой же провал, как гейт:
    // шаблон не пишется, ошибка не терминальная.
    // Проверяются письма, которые ляжут в he_templates (после починки
    // приветствия). Клиента не с чем сравнить (ни сайта, ни имени компании) —
    // проверки нет, но то, что письма называют такое слово, видно в логе.
    const finalBrandLeaks = brandLeaksOf(letters);
    if (finalBrandLeaks.length) {
      stageLog(
        ctx,
        `[template] в письмах назван наш бренд или компания из примера, а клиент проекта — другая компания: шаблон не сохраняем — ${describeHeBrandLeaks(finalBrandLeaks, 20)}`,
      );
    } else if (language === 'en' && brandGuard.ownership === 'unknown') {
      const named = findHeBrandLeaks(letters);
      if (named.length) {
        stageLog(
          ctx,
          `[template] письма называют наш бренд или компанию из примера (${describeHeBrandLeaks(named, 6)}), но ни сайта, ни имени компании клиента нет — сравнить не с чем, шаблон не держим`,
        );
      }
    }
    if (!gate.ok) {
      stageLog(ctx, `[template] гейт отправки: шаблон не сохраняем — ${describeHeTemplateOperatorGate(gate, 20)}`);
      throw new HeTemplateOperatorGateError(gate);
    }
    if (finalBrandLeaks.length) throw new HeLetterBrandLeakError('template', finalBrandLeaks);
  }

  const segmentWarnings = validateSegmentVariants(letters, analysis);
  if (segmentWarnings.length) stageLog(ctx, `[template] segment_warnings: ${segmentWarnings.join(' | ')}`);
  const lengthWarnings = collectLengthWarnings(letters);
  if (lengthWarnings.length) stageLog(ctx, `[template] length_warnings: ${lengthWarnings.join(' | ')}`);

  // Английские письма 'us': регламент ФИНАЛЬНЫХ писем (тех, что ложатся в he_templates; абзацы
  // здесь тоже) — только предупреждение, статус 'ready' он не меняет. Список
  // ложится в personalization_plan.rule_violations, только если он не пуст:
  // его показывает staff-экран шаблона (Step5Template); клиенту
  // personalization_plan не отдаётся (clientEngProjection, TEMPLATE_FIELDS).
  // RU/PL и английские письма проекта 'ru' — ни списка, ни строки лога (блок
  // «Предупреждения регламента писем» шага 5 у них не появляется).
  const finalRuleViolations: HeLetterRuleWarning[] =
    usEnglish
      ? [
          ...[...collectRuleViolations(letters), ...checkLetterParagraphs(lettersForCheck(letters), language, market)].map(
            ({ rule, letter, detail }) => ({ rule, letter, detail }),
          ),
          ...rolledBackCriticIssues,
        ]
      : [];
  if (finalRuleViolations.length) {
    stageLog(
      ctx,
      `[template] регламент финальных писем (предупреждение, шаблон сохраняем): ${finalRuleViolations.length} нарушений — ${finalRuleViolations
        .slice(0, 5)
        .map((v) => v.detail)
        .join('; ')}`,
    );
  }

  // Только 'us': паузы между письмами — из цепочки, которую клиент видел и
  // правил на шаге Letters кабинета, по номеру письма; лесенка CHAIN_WAIT_DAYS
  // (её уже дал parsedToChainLetters) остаётся там, где у цепочки нет паузы с
  // таким номером (chainTiming.ts). Последним шагом перед записью: ни одна
  // проверка выше паузы не читает, а повторы и рерайт собирают письма заново
  // через parsedToChainLetters. RU/PL — лесенка, как раньше.
  if (market === 'us') {
    const timing = applyHeChainTiming(letters, chainLetters);
    letters = timing.letters;
    stageLog(
      ctx,
      `[template] паузы писем: из цепочки ${timing.fromChain}, по лесенке ${timing.fromLadder} (первое письмо без паузы)`,
    );
  }

  const personalizationPlan: HePersonalizationPlan = {
    letters: plan.data.personalization_plan,
    additions: plan.data.segment_additions,
    segment_variants: plan.data.letters,
    operator_mapping: operatorMapping,
    ...(finalRuleViolations.length ? { rule_violations: finalRuleViolations } : {}),
  };

  // fixed_block, план персонализации и письма — текст модели: один NUL или
  // одиночный UTF-16 суррогат, и PostgREST отвергает вставку уже после всех
  // оплаченных вызовов (план, письма, проверки, критик, рерайт) — стадия падает
  // и на повторе покупает письма заново. Чистка трогает только эти два символа:
  // текст без них (вся кириллица и латиница) ложится байт-в-байт тем же.
  // Только рынок 'us': у проекта 'ru' запись — как до переноса ENG.
  const templateRow = {
    base_id: baseId,
    vertical_id: base.vertical_id,
    fixed_block: plan.data.fixed_block,
    personalization_plan: personalizationPlan,
    letters,
    status: 'ready',
    llm_model: model,
    tokens_used: usage.tokensUsed,
    cost_usd: usage.costUsd,
  };
  const { data: inserted, error: insError } = await ctx.supabase
    .from('he_templates')
    .insert(market === 'us' ? stripUnstorableJsonChars(templateRow) : templateRow)
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
