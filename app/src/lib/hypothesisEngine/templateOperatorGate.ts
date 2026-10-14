/**
 * Гейт отправки финальных писем по операторам персонализации ({{var}}).
 * ЧИСТЫЙ модуль: ни БД, ни модели, ни сети; импортов значений нет вовсе.
 *
 * ЗАЧЕМ. Письмо уходит рассыльщику с {{var}} внутри, а значение переменной
 * кладёт запуск (launchHandoff.ts, mapBaseRowsToLeads) ТОЛЬКО по сохранённому
 * operator_mapping: matched-оператор — ячейка своей колонки (пустая → fallback
 * или ''), unmatched с fallback — fallback всем лидам, unmatched без fallback —
 * НИЧЕГО. Для последнего рассыльщик подставляет пустоту (а {{firstName}} — своё
 * встроенное поле лида, у ENG-баз пустое всегда), и получатель читает
 * «Hello ,» или тему «Quick question about ». В ENG-базах колонки с именем
 * человека нет вовсе (HE_AUTO_COLLECT_COLUMNS: company, website, email, …),
 * поэтому «Hello {{firstName}},» из старого английского регламента ломалось у
 * КАЖДОГО получателя.
 *
 * ЧТО СЧИТАЕТСЯ (checkHeTemplateOperators) — от ФИНАЛЬНЫХ писем + колонок базы,
 * а не от списка маппинга: в маппинге лежат и операторы плана с matched:false,
 * которых в письмах может не быть (их отсутствие ничего не ломает), а оператор,
 * которого в маппинге нет, запуск не наполнит вовсе. Маппинг читается только
 * затем, чтобы узнать, КАКУЮ колонку и какой fallback запуск возьмёт для
 * оператора, — и колонка обязана быть среди колонок базы. Три списка по
 * маппингу (четвёртый, по строкам базы, — ниже, «ПУСТАЯ ЯЧЕЙКА»):
 *  - subjectUnresolved — оператор в ОТПРАВЛЯЕМОЙ теме без колонки базы
 *    (fallback в теме не принимается — правило стадии template, «fallback в
 *    теме невозможен»);
 *  - unbacked — оператор в отправляемом тексте без колонки и без fallback.
 *    Оператор с ИМЕНЕМ ЧЕЛОВЕКА (firstName и т.п.) без колонки сюда попадает
 *    и с fallback: «there, does this fit?» посреди письма читается неверно, а
 *    строку приветствия чинит repairHeNameGreetings. И оператор без колонки,
 *    чей fallback (его получает КАЖДЫЙ получатель) в теле встал бы туда, где
 *    читается неверно, — проверка места, как у пустой ячейки с fallback
 *    модели, но с поблажками по тексту самого fallback (заглавная буква в
 *    начале предложения, «Hi there,», последнее слово перед следующим; см.
 *    standInContextProblem; поля fallback/fallbackProblem);
 *  - malformed — литеральные {{…}}, которые не являются правильным
 *    оператором («{{first name}}», «{{RANDOM | a | b}}»), и любые оставшиеся
 *    фигурные скобки («{company}», «{{firstName}»): запуск их не наполняет,
 *    рассыльщик печатает или съедает.
 *
 * КАКИЕ ТЕКСТЫ ОТПРАВЛЯЮТСЯ — ровно те, что берёт launchHandoff.buildLaunchSequence:
 * тело каждого письма, тела его вариантов (B), тексты сегментных вариантов
 * (они ЗАМЕНЯЮТ тело в сегментной кампании) и тема ТОЛЬКО у первого письма и
 * его вариантов — у писем 2+ запуск тему обнуляет (тред). Темы писем 2+ гейт
 * поэтому не проверяет: за невидимую получателю тему перегенерация писем
 * платила бы зря. Поменяется правило buildLaunchSequence — менять и здесь.
 *
 * Строка приветствия чинится бесплатно и детерминированно ДО гейта
 * (repairHeNameGreetings): «Hello {{firstName}},» без колонки имени → «Hello,».
 *
 * ПУСТАЯ ЯЧЕЙКА (с 09.10.2026). Оператор с колонкой у строки, где ячейка
 * пуста, запуск наполняет fallback'ом маппинга, а без него — пустотой
 * («I looked at  and…» у строки Google Maps без сайта). Поэтому:
 *  - withHeEmptyCellFallbacks — бесплатная детерминированная замена по ВИДУ
 *    колонки из закрытой карты (HE_STAND_INS: «your company», «your website»,
 *    «your area», «your industry») в fallback каждого оператора с колонкой без
 *    своего fallback. Её зовут стадия template (замена ложится в
 *    operator_mapping, и по нему лидов строит mapBaseRowsToLeads у запуска,
 *    ночного долива и переноса), а запуск, долив и перенос — ещё раз, для
 *    шаблонов, записанных до этой правки (в памяти, без записи в шаблон);
 *  - четвёртый список гейта, emptyCells, — оператор, у которого колонка пуста
 *    хотя бы в одной строке С АДРЕСОМ (rows + emailColumn), а замены нет (вид
 *    колонки не в карте) или она встала бы туда, где читается неверно (начало
 *    предложения, после артикля или квантора — вплотную или через
 *    прилагательное, вплотную к слову, в строке приветствия, у
 *    фраз-существительных — перед существительным). Без rows список пуст.
 *
 * Стадия template (us) зовёт ещё два помощника отсюда: heColumnsWithoutStandIn —
 * какие колонки не показывать модели плана, и heTemplateOperatorGateProblemsEn —
 * английское описание отказа для подсказки платного повтора по операторам.
 *
 * Модуль не трогает словарь синонимов колонок (OPERATOR_ALIASES в
 * stages/template.ts): он общий с RU, и «industry → category» подставил бы
 * RU-специалисту код ОКВЭД. Синонимы уже применены к маппингу при генерации
 * (mapOperatorsToColumns), гейт читает их результат.
 */

import type { HeOperatorMapping } from './types';

/**
 * Синтаксис оператора — ОДИН на стадию и гейт: stages/template.ts строит из
 * этого источника свой OPERATOR_RE (extractPersonalizationOperators).
 */
export const HE_OPERATOR_PATTERN = '\\{\\{\\s*([A-Za-zА-Яа-яЁё0-9_.-]+)\\s*\\}\\}';

/** Где лежит проблемный оператор. */
export interface HeTemplateOperatorIssue {
  /** 1-based номер письма. */
  letter: number;
  /** A — основной текст, B — вариант письма (variants[]), segment — сегментный вариант. */
  variant: 'A' | 'B' | 'segment';
  field: 'subject' | 'body';
  /** Имя оператора без скобок — у subjectUnresolved/unbacked. */
  operator?: string;
  /** Литеральный фрагмент (≤ 60 символов) — у malformed. */
  fragment?: string;
  /** Условие сегмента — у variant 'segment'. */
  segment?: string;
  /**
   * Только у unbacked: оператор без колонки, чей fallback (его получает КАЖДЫЙ
   * получатель) стоит там, где читается неверно, — сам fallback и причина.
   */
  fallback?: string;
  fallbackProblem?: Exclude<HeEmptyCellReason, 'no_stand_in'>;
}

/** Почему пустая ячейка колонки прочиталась бы неверно (см. standInContextProblem). */
export type HeEmptyCellReason =
  | 'no_stand_in'
  | 'sentence_start'
  | 'after_determiner'
  | 'glued'
  | 'greeting'
  | 'repeats'
  | 'modifier';

/** Оператор с колонкой, у которой есть пустые ячейки, и пустоту нечем закрыть. */
export interface HeTemplateEmptyCellIssue extends HeTemplateOperatorIssue {
  operator: string;
  column: string;
  reason: HeEmptyCellReason;
  /** Строк с адресом, где ячейка пуста, и всего строк с адресом. */
  emptyRows: number;
  rows: number;
  /** Замена, которая встала бы на место пустоты (нет — 'no_stand_in'). */
  standIn?: string;
}

/** Оператор, у которого часть строк получит замену вместо значения, — для лога и аудита. */
export interface HeTemplateStandInUse {
  operator: string;
  column: string;
  standIn: string;
  emptyRows: number;
  rows: number;
}

export interface HeTemplateOperatorGateResult {
  /** true — ни одного списка: письма можно отдавать запуску. */
  ok: boolean;
  subjectUnresolved: HeTemplateOperatorIssue[];
  unbacked: HeTemplateOperatorIssue[];
  malformed: HeTemplateOperatorIssue[];
  /** Пустые ячейки, которые получатель прочёл бы пустотой или неверной заменой. */
  emptyCells: HeTemplateEmptyCellIssue[];
  /** Не ошибка: операторы, чьи пустые ячейки закрывает замена (по одному на оператор). */
  standIns: HeTemplateStandInUse[];
}

export interface HeTemplateOperatorGateInput {
  /** he_templates.letters как есть (jsonb): массив писем {subject, body, variants?, segment_variants?}. */
  letters: unknown;
  /** he_bases.columns как есть. */
  columns: unknown;
  /** he_templates.personalization_plan.operator_mapping как есть (нет — null/undefined). */
  operatorMapping?: unknown;
  /**
   * he_bases.data как есть — для проверки пустых ячеек. Считаются только
   * строки с непустой ячейкой `emailColumn`: строка без адреса лида не даёт
   * (mapBaseRowsToLeads), и её пустой сайт никто не прочтёт. Нет rows или
   * emailColumn — список emptyCells пуст (проверки нет).
   */
  rows?: unknown;
  emailColumn?: string | null;
}

/** Одна починка строки приветствия — для лога стадии. */
export interface HeGreetingRepair {
  letter: number;
  variant: 'A' | 'B' | 'segment';
  segment?: string;
  before: string;
  after: string;
}

/* ── Разбор входа (jsonb из БД — форма не гарантирована) ── */

type Row = Record<string, unknown>;

function asRow(value: unknown): Row | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Ключ оператора без регистра и разделителей: им гейт узнаёт имена людей
 * (first_name = firstName = FirstName).
 */
function compactOperator(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9а-яё]/g, '');
}

/**
 * Операторы, которые означают ИМЯ ЧЕЛОВЕКА. Без колонки им нечем стать: у
 * fallback («there», «colleague») место только в приветствии, и там оператор
 * убирает починка, а не fallback.
 */
const NAME_OPERATOR_KEYS = new Set([
  'firstname',
  'first',
  'fname',
  'givenname',
  'name',
  'fullname',
  'lastname',
  'surname',
  'contactname',
  'contactfirstname',
  'recipientname',
  'personname',
  'leadname',
  'prospectname',
  'имя',
  'фио',
]);

export function isHeNameOperator(name: string): boolean {
  return NAME_OPERATOR_KEYS.has(compactOperator(name));
}

interface Resolution {
  /** Колонка базы, которую запуск прочитает для оператора (null — нет). */
  column: string | null;
  /** fallback маппинга (trim; '' — нет). */
  fallback: string;
}

/**
 * Как запуск наполнит оператор: по записи маппинга (поиск без регистра —
 * рассыльщик регистр не различает, а extractPersonalizationOperators хранит
 * одно написание). Колонка засчитывается, только если она есть среди колонок
 * базы: запуск читает `row[column]`, и колонки, которой в базе нет, у строки не
 * будет.
 */
function makeResolver(columns: unknown, operatorMapping: unknown): (operator: string) => Resolution {
  const columnSet = new Set(asList(columns).filter((c): c is string => typeof c === 'string'));
  const byKey = new Map<string, Resolution>();
  for (const raw of asList(operatorMapping)) {
    const m = asRow(raw) as Partial<HeOperatorMapping> | null;
    if (!m || typeof m.operator !== 'string' || !m.operator.trim()) continue;
    const key = m.operator.trim().toLowerCase();
    if (byKey.has(key)) continue;
    const column = m.matched === true && typeof m.column === 'string' && columnSet.has(m.column) ? m.column : null;
    byKey.set(key, { column, fallback: asText(m.fallback).trim() });
  }
  return (operator) => byKey.get(operator.trim().toLowerCase()) ?? { column: null, fallback: '' };
}

/* ── Пустая ячейка колонки → замена (только us) ── */

interface HeStandIn {
  phrase: string;
  /**
   * Фраза читается только как существительное: «businesses in your area» —
   * да, «your area businesses» — нет. «your company team» и «your website
   * traffic» читаются, поэтому у них false.
   */
  nounOnly: boolean;
  /**
   * Слова того же смысла: вплотную до или после оператора замена их повторила
   * бы («your site your website», «your website, your website»).
   */
  near: readonly string[];
}

/**
 * ЗАКРЫТАЯ карта «вид колонки → замена пустой ячейки». Ключ — имя колонки без
 * регистра и разделителей (compactOperator): только точное совпадение, без
 * догадок по подстроке. Почему каждая фраза читается верно ВНУТРИ предложения
 * и ничего не выдумывает:
 *  - компания → «your company»: «how your company handles…», «at your
 *    company», «Quick question about your company», «your company's team».
 *    Строка базы — всегда компания, фраза называет её, а не придумывает имя;
 *  - сайт → «your website»: «I looked at your website and…», «visitors to
 *    your website», «your website traffic». Фраза ПРЕДПОЛАГАЕТ, что сайт есть,
 *    — у строки Google Maps без сайта в карточке это может быть неправдой
 *    (решение владельца, см. отчёт лейна);
 *  - город/место → «your area»: «clinics in your area», «businesses in your
 *    area like yours»;
 *    перед существительным («your area clinics») не читается — nounOnly;
 *  - отрасль/категория → «your industry»: «companies in your industry»;
 *    «your industry owners» не читается — nounOnly.
 * Остальным колонкам (адрес, телефон, должность/вакансия, выручка, штат,
 * email, ИНН, …) замены нет: любая фраза вместо них — выдумка или чепуха
 * («at your address», «hiring a your role»). Их пустая ячейка — отказ гейта.
 */
const HE_STAND_INS: ReadonlyArray<{ columns: readonly string[]; standIn: HeStandIn }> = [
  {
    columns: ['company', 'companyname', 'organization', 'organisation'],
    standIn: {
      phrase: 'your company',
      nounOnly: false,
      near: ['company', 'business', 'firm', 'brand', 'organization', 'organisation'],
    },
  },
  {
    columns: ['website', 'site', 'url', 'domain', 'websiteurl'],
    standIn: {
      phrase: 'your website',
      nounOnly: false,
      near: ['website', 'site', 'homepage', 'page', 'url', 'domain', 'web'],
    },
  },
  {
    columns: ['city', 'town', 'area', 'location', 'region'],
    standIn: { phrase: 'your area', nounOnly: true, near: ['area', 'city', 'town', 'region', 'location'] },
  },
  {
    columns: ['industry', 'category', 'niche', 'sector'],
    standIn: { phrase: 'your industry', nounOnly: true, near: ['industry', 'niche', 'sector', 'field', 'category', 'space'] },
  },
];

const STAND_IN_BY_COLUMN_KEY: ReadonlyMap<string, HeStandIn> = new Map(
  HE_STAND_INS.flatMap(({ columns, standIn }) => columns.map((key) => [key, standIn] as const)),
);

/** Замена пустой ячейки колонки по карте (null — у колонки такого вида замены нет). */
function heEmptyCellStandIn(column: string): string | null {
  return STAND_IN_BY_COLUMN_KEY.get(compactOperator(column))?.phrase ?? null;
}

/**
 * Маппинг с заменами пустых ячеек: каждому оператору с колонкой (matched и
 * колонка есть среди колонок базы) без своего fallback — фраза его вида
 * колонки из карты. Независимо от того, пусты ли ячейки СЕЙЧАС: ночной долив
 * кладёт в ту же кампанию строки новых сборок по этому же маппингу, и у них
 * сайта может не быть, даже если у первой базы он был везде. Fallback
 * подставляется только в пустую ячейку (mapBaseRowsToLeads), заполненным
 * строкам он не виден. Остальные записи — как были (тот же объект);
 * вход не мутирует; не-массив (битый jsonb) читается как пустой маппинг — тогда
 * операторы писем гейт назовёт unbacked. RU это не зовёт: вызывающие скоупят
 * на market 'us'.
 */
export function withHeEmptyCellFallbacks<M extends HeOperatorMapping>(
  operatorMapping: readonly M[] | null | undefined,
  columns: unknown,
): { mapping: M[]; added: Array<{ operator: string; column: string; fallback: string }> } {
  const columnSet = new Set(asList(columns).filter((c): c is string => typeof c === 'string'));
  const added: Array<{ operator: string; column: string; fallback: string }> = [];
  const mapping = (asList(operatorMapping) as M[]).map((m) => {
    if (!m || m.matched !== true || typeof m.column !== 'string' || !columnSet.has(m.column)) return m;
    if (asText(m.fallback).trim() !== '') return m;
    const phrase = heEmptyCellStandIn(m.column);
    if (!phrase) return m;
    added.push({ operator: m.operator, column: m.column, fallback: phrase });
    return { ...m, fallback: phrase };
  });
  return { mapping, added };
}

/**
 * Слова, после которых замена «your …» читается неверно («the your website»).
 * «that» в списке нет: перед оператором это почти всегда союз («I noticed
 * that your company is hiring» читается).
 */
const DETERMINER_BEFORE_RE = /\b(?:the|a|an|this|these|those|your|our|their|my|his|her|its)[ \t]+$/i;
/**
 * Артикли, местоимения и кванторы, которые ОПРЕДЕЛЯЮТ оператор, стоя вплотную
 * («each your company») или через одно прилагательное («the local your area»).
 * «that» нет — по той же причине, что в DETERMINER_BEFORE_RE. Fail-closed:
 * «both/all/either/neither your company» вплотную по-английски читается, но
 * такой оборот в письме редок, а пропуск «each your company» ушёл бы
 * получателю.
 */
const DETERMINER_WORDS = new Set([
  'the', 'a', 'an', 'this', 'these', 'those', 'your', 'our', 'their', 'my', 'his', 'her', 'its',
  'each', 'every', 'any', 'some', 'no', 'all', 'other', 'another', 'most', 'many', 'such', 'both', 'either',
  'neither', 'fellow',
]);
/**
 * Прилагательные, через которые артикль/квантор ещё определяет оператор
 * («the local {{city}} market», «a similar {{industry}} firm»). Список закрытый,
 * плюс суффиксы, почти всегда прилагательные (-ous, -ful, -less). Слово не из
 * списка между ними — существительное, и оператор начинает новую группу:
 * «a way {{company}} could», «the team {{company}} built», «this year
 * {{company}} grew», «such as {{company}}», «each of {{company}}'s» читаются.
 * Прилагательное не из списка («the dental {{city}} market») гейт пропустит.
 */
const ADJECTIVE_WORDS = new Set([
  'local', 'regional', 'national', 'nearby', 'same', 'whole', 'entire', 'own', 'new', 'old', 'big', 'small',
  'large', 'little', 'top', 'best', 'biggest', 'largest', 'smallest', 'latest', 'fastest', 'newest', 'oldest',
  'bigger', 'larger', 'smaller', 'leading', 'growing', 'established', 'existing', 'independent', 'typical',
  'average', 'similar', 'different', 'certain', 'major', 'main', 'key', 'current', 'busy', 'first', 'next',
  'last', 'few', 'several', 'single', 'specific', 'particular', 'right', 'good', 'great',
]);
const ADJECTIVE_SUFFIX_RE = /(?:ous|ful|less)$/;
/** Граница части предложения: знак препинания, скобка, кавычка, тире или « - ». */
const CLAUSE_BREAK_RE = /[.,;:!?()[\]{}"“”«»—–]|\s-\s/;

/**
 * Артикль/квантор определяет оператор в той же части предложения: вплотную
 * («each {{company}}») или через одно прилагательное («the local {{city}}»,
 * «any other {{industry}}» — «other» и сам квантор). `lead` — текст строки до
 * оператора.
 */
function determinerGovernsOperator(lead: string): boolean {
  const clause = lead.split(CLAUSE_BREAK_RE).pop() ?? '';
  const words = (clause.match(/[A-Za-z'’]+/g) ?? []).map((w) => w.toLowerCase());
  const last = words[words.length - 1];
  const beforeLast = words[words.length - 2];
  if (last === undefined) return false;
  if (DETERMINER_WORDS.has(last)) return true;
  return (
    beforeLast !== undefined &&
    DETERMINER_WORDS.has(beforeLast) &&
    (ADJECTIVE_WORDS.has(last) || ADJECTIVE_SUFFIX_RE.test(last))
  );
}

/**
 * Fallback, которым приветствие читается и без имени: «Hi there,», «Hi team,»,
 * «Dear all,». «there» — только после hi/hello/hey («Dear there» не
 * читается).
 */
const GREETING_SAFE_FALLBACKS: ReadonlyMap<string, RegExp> = new Map([
  ['there', /^(?:hello|hi|hey)$/i],
  ['team', /.*/],
  ['all', /.*/],
]);
/** Строка до оператора — ровно приветствие: «Hi », «Hello, », «Good morning ». */
const GREETING_ONLY_LEAD_RE = /^[ \t]*(hello|hi|hey|dear|greetings|good\s+(?:morning|afternoon|evening|day))[ \t]*,?[ \t]*$/i;
/**
 * Последние слова фраз карты, которые читаются и перед существительным
 * («your company team», «your website traffic»: nounOnly false у HE_STAND_INS).
 * Fallback с таким последним словом проверяется так же.
 */
const ADJUNCT_LAST_WORDS = new Set(['company', 'website']);
/**
 * Местоимения, которые не определяют следующее слово: после fallback «yours»
 * идёт сказуемое («teams like yours hire»), и читается он, только если
 * следующее слово — глагол или служебное слово. Существительное («businesses
 * like yours owners») — отказ, как и любое слово не из списков (fail-closed).
 */
const STANDALONE_PRONOUNS = new Set(['yours', 'ours', 'theirs', 'mine', 'you', 'them', 'us', 'it']);
const VERBS_AFTER_PRONOUN = new Set([
  'hire', 'hires', 'hired', 'hiring', 'need', 'needs', 'needed', 'use', 'uses', 'used', 'run', 'runs', 'ran',
  'grow', 'grows', 'grew', 'get', 'gets', 'got', 'see', 'sees', 'saw', 'handle', 'handles', 'handled', 'face',
  'faces', 'faced', 'want', 'wants', 'wanted', 'spend', 'spends', 'spent', 'struggle', 'struggles', 'struggled',
  'rely', 'relies', 'relied', 'lose', 'loses', 'lost', 'miss', 'misses', 'missed', 'pay', 'pays', 'paid', 'keep',
  'keeps', 'kept', 'find', 'finds', 'found', 'work', 'works', 'worked', 'look', 'looks', 'looked', 'tend',
  'tends', 'tended', 'usually', 'often', 'typically', 'already', 'still', 'rarely', 'just', 'now',
]);

/**
 * Читается ли следующее слово после fallback, по его ПОСЛЕДНЕМУ слову (см.
 * standInContextProblem, modifier): слово карты, что читается перед
 * существительным, — да; местоимение — только перед глаголом или служебным
 * словом; иначе — только перед служебным словом (NOUN_FOLLOWERS).
 */
function fallbackReadsBefore(fallback: string, next: string): boolean {
  const lastWord = /([A-Za-z]+)[^A-Za-z]*$/.exec(fallback)?.[1]?.toLowerCase() ?? '';
  if (NOUN_FOLLOWERS.has(next)) return true;
  if (ADJUNCT_LAST_WORDS.has(lastWord)) return true;
  return STANDALONE_PRONOUNS.has(lastWord) && VERBS_AFTER_PRONOUN.has(next);
}
/** Конец предложения перед вхождением: «…today. {{company}} is» → «…today. your company is». */
const SENTENCE_END_BEFORE_RE = /[.!?]["'”’)\]]*[ \t]+$/;
/** Строка приветствия письма (та же, что чинит GREETING_LINE_RE, но с любым продолжением). */
const GREETING_START_RE = /^[ \t]*(?:hello|hi|hey|dear|greetings|good\s+(?:morning|afternoon|evening|day))\b/i;
/**
 * Слова, которые после существительного-фразы («your area», «your industry»)
 * читаются: предлоги, союзы, связки, вспомогательные и местоимения. Любое другое
 * слово сразу после такого оператора делает его определением («{{city}}
 * clinics» → «your area clinics») — отказ. Список закрытый: неизвестное слово
 * считается определением (fail-closed).
 */
const NOUN_FOLLOWERS = new Set([
  'and', 'or', 'but', 'nor', 'so', 'yet', 'in', 'on', 'at', 'to', 'for', 'with', 'without', 'of', 'from', 'by',
  'as', 'into', 'about', 'than', 'like', 'near', 'around', 'across', 'over', 'is', 'are', 'was', 'were', 'be',
  'been', 'has', 'have', 'had', 'can', 'could', 'will', 'would', 'should', 'may', 'might', 'must', 'do', 'does',
  'did', 'that', 'which', 'who', 'whose', 'where', 'when', 'while', 'because', 'if', 'too', 'also', 'i', 'we',
  'you', 'they', 'it', 'he', 'she',
]);

/**
 * Где замена прочиталась бы неверно (null — читается). Смотрит ОДНО вхождение
 * оператора [start, end) в отправляемом тексте:
 *  - sentence_start — начало строки/темы или после «. ! ?»: фраза со строчной
 *    («your company caught my eye»);
 *  - after_determiner — артикль, местоимение или квантор определяет оператор:
 *    вплотную («the your website», «each your company») или через одно
 *    прилагательное («the local your area»), в той же части предложения
 *    (determinerGovernsOperator);
 *  - glued — вплотную к букве, цифре или знаку адреса с любой стороны
 *    («www.{{website}}», «{{city}}-based», «{{category}}s»); «'s» после — можно;
 *  - greeting — в строке приветствия тела («Hi your company team,»);
 *  - repeats — рядом слово того же смысла (HeStandIn.near): «your site
 *    {{website}}» → «your site your website»;
 *  - modifier — у nounOnly-фразы следующее слово не из NOUN_FOLLOWERS.
 * Фраза карты (standIn) — фиксированная группа «your …»: проверяется строго,
 * как выше. Fallback не из карты (standIn null) — без repeats: его слов карта
 * не знает. У fallback модели для колонки с пустыми ячейками остальное так же
 * строго, как у фразы-существительного: его вид неизвестен, а «a local company
 * owners» или «Teams like yours is» ушли бы строкам с пустой ячейкой. Мягче —
 * только fallback оператора БЕЗ колонки (`unmatchedFallback`, его получает
 * каждый получатель; до 09.10.2026 его место не проверялось вовсе), по его
 * тексту:
 *  - с заглавной буквы («Local businesses») в начале предложения читается;
 *  - «there»/«team»/«all» сразу после приветствия и перед знаком или концом
 *    строки — тоже («Hi there,», «Hi team,»), см. GREETING_SAFE_FALLBACKS;
 *  - modifier решает его последнее слово (fallbackReadsBefore).
 */
function standInContextProblem(
  t: SentText,
  start: number,
  end: number,
  standIn: HeStandIn | null,
  unmatchedFallback = '',
): Exclude<HeEmptyCellReason, 'no_stand_in'> | null {
  const before = t.text.slice(0, start);
  const lineStart = before.lastIndexOf('\n') + 1;
  const lead = before.slice(lineStart);
  const fallback = standIn ? '' : unmatchedFallback;
  const ownText = fallback !== '';
  if ((lead.trim() === '' || SENTENCE_END_BEFORE_RE.test(lead)) && !(ownText && /^\p{Lu}/u.test(fallback))) {
    return 'sentence_start';
  }
  if (DETERMINER_BEFORE_RE.test(lead) || determinerGovernsOperator(lead)) return 'after_determiner';
  if (standIn) {
    // Только в той же строке: слово следующего абзаца соседом не считается.
    const wordBefore = /([A-Za-z]+)[ \t,:;(\[\-–—"'“‘]*$/.exec(lead)?.[1]?.toLowerCase();
    const wordAfter = /^[ \t,:;)\]\-–—"'”’]*([A-Za-z]+)/.exec(t.text.slice(end))?.[1]?.toLowerCase();
    if ((wordBefore && standIn.near.includes(wordBefore)) || (wordAfter && standIn.near.includes(wordAfter))) {
      return 'repeats';
    }
  }
  const prev = before.slice(-1);
  if (prev && !/[\s("'“‘[]/.test(prev)) return 'glued';
  const next = t.text.charAt(end);
  if (/[\p{L}\p{N}_\-/@]/u.test(next) || (next === '.' && /[\p{L}\p{N}]/u.test(t.text.charAt(end + 1)))) {
    return 'glued';
  }
  if (t.field === 'body') {
    const firstLineStart = t.text.search(/\S/);
    const firstLineEnd = firstLineStart < 0 ? -1 : t.text.indexOf('\n', firstLineStart);
    const inFirstLine = firstLineStart >= 0 && start >= firstLineStart && (firstLineEnd < 0 || start < firstLineEnd);
    if (inFirstLine && GREETING_START_RE.test(t.text.slice(firstLineStart, firstLineEnd < 0 ? undefined : firstLineEnd))) {
      const greeting = ownText ? GREETING_ONLY_LEAD_RE.exec(lead)?.[1] : undefined;
      const safeAfter = GREETING_SAFE_FALLBACKS.get(fallback.toLowerCase());
      const endsGreeting = /^[ \t]*(?:[,!.:;]|\r?$)/.test(t.text.slice(end).split('\n')[0] ?? '');
      if (!(greeting && safeAfter?.test(greeting) && endsGreeting)) return 'greeting';
    }
  }
  if (standIn?.nounOnly ?? true) {
    const word = /^[ \t]+([A-Za-z]+)/.exec(t.text.slice(end));
    const nextWord = word?.[1]?.toLowerCase();
    if (nextWord && !(ownText ? fallbackReadsBefore(fallback, nextWord) : NOUN_FOLLOWERS.has(nextWord))) {
      return 'modifier';
    }
  }
  return null;
}

/* ── Отправляемые тексты ── */

interface SentText {
  letter: number;
  variant: 'A' | 'B' | 'segment';
  field: 'subject' | 'body';
  segment?: string;
  text: string;
}

/** Все тексты, которые запуск отдаёт рассыльщику (см. шапку: темы — только у письма 1). */
function sentTexts(letters: unknown): SentText[] {
  const out: SentText[] = [];
  asList(letters).forEach((raw, i) => {
    const letter = asRow(raw);
    if (!letter) return;
    const n = i + 1;
    if (i === 0) out.push({ letter: n, variant: 'A', field: 'subject', text: asText(letter.subject) });
    out.push({ letter: n, variant: 'A', field: 'body', text: asText(letter.body) });
    for (const rawVariant of asList(letter.variants)) {
      const v = asRow(rawVariant);
      if (!v) continue;
      if (i === 0) out.push({ letter: n, variant: 'B', field: 'subject', text: asText(v.subject) });
      out.push({ letter: n, variant: 'B', field: 'body', text: asText(v.body) });
    }
    for (const rawSegment of asList(letter.segment_variants)) {
      const s = asRow(rawSegment);
      if (!s) continue;
      out.push({ letter: n, variant: 'segment', field: 'body', segment: asText(s.when), text: asText(s.text) });
    }
  });
  return out;
}

/**
 * Остаток фигурных скобок ПОСЛЕ вырезания правильных операторов: «{{…}}» с
 * чем угодно внутри, «{…}» (одинарная заглушка вида «{company}») и любая
 * одиночная скобка («{{{firstName}}}» оставляет «{ }» вокруг подстановки).
 * В деловом письме фигурной скобки не бывает — это след шаблона.
 */
const STRAY_BRACES_RE = /\{\{[^{}\n]{0,60}\}\}|\{[^{}\n]{0,60}\}|[{}]/g;

/**
 * Строки, которые станут лидами: ячейка адреса непустая — то же условие, по
 * которому mapBaseRowsToLeads вообще берёт строку. Пустая ячейка колонки — по
 * тому же правилу, что у него (`String(v ?? '').trim() === ''`).
 */
function emptyCellCounter(rows: unknown, emailColumn: string | null | undefined): (column: string) => {
  empty: number;
  rows: number;
} {
  const withAddress = emailColumn
    ? asList(rows)
        .map(asRow)
        .filter((r): r is Row => r !== null && String(r[emailColumn] ?? '').trim() !== '')
    : [];
  const cache = new Map<string, number>();
  return (column) => {
    let empty = cache.get(column);
    if (empty === undefined) {
      empty = withAddress.filter((r) => String(r[column] ?? '').trim() === '').length;
      cache.set(column, empty);
    }
    return { empty, rows: withAddress.length };
  };
}

/**
 * Гейт: что в ОТПРАВЛЯЕМЫХ текстах писем не наполнится данными. Контракт для
 * запуска (launchTemplate.ts) и стадии template: вход — строки БД как есть,
 * `ok === false` — шаблон не пишется / запуск us-шаблона — отказ. Пустой/битый
 * `letters` — ok (нечего проверять: у запуска на это свой отказ «нет писем»).
 * Пустые ячейки (emptyCells) проверяются только при переданных rows и
 * emailColumn — оба вызывающих их передают; маппинг к этому моменту уже прошёл
 * withHeEmptyCellFallbacks.
 */
export function checkHeTemplateOperators(input: HeTemplateOperatorGateInput): HeTemplateOperatorGateResult {
  const resolve = makeResolver(input.columns, input.operatorMapping);
  const emptyOf = emptyCellCounter(input.rows, input.emailColumn);
  const subjectUnresolved: HeTemplateOperatorIssue[] = [];
  const unbacked: HeTemplateOperatorIssue[] = [];
  const malformed: HeTemplateOperatorIssue[] = [];
  const emptyCells: HeTemplateEmptyCellIssue[] = [];
  const standInByOperator = new Map<string, HeTemplateStandInUse>();
  const operatorRe = new RegExp(HE_OPERATOR_PATTERN, 'g');

  for (const t of sentTexts(input.letters)) {
    const where = {
      letter: t.letter,
      variant: t.variant,
      field: t.field,
      ...(t.segment !== undefined ? { segment: t.segment } : {}),
    };
    const seen = new Set<string>();
    // Одна причина пустой ячейки на оператор и текст: сводке хватит первой.
    const emptyReported = new Set<string>();
    // То же для fallback оператора без колонки, вставшего не к месту.
    const fallbackReported = new Set<string>();
    for (const m of t.text.matchAll(operatorRe)) {
      const operator = (m[1] ?? '').trim();
      const key = operator.toLowerCase();
      if (!operator) continue;
      const { column, fallback } = resolve(operator);
      const fallbackCounts = fallback !== '' && !isHeNameOperator(operator);
      if (!seen.has(key)) {
        seen.add(key);
        if (t.field === 'subject' && !column) subjectUnresolved.push({ ...where, operator });
        if (!column && !fallbackCounts) unbacked.push({ ...where, operator });
      }
      // Оператор без колонки с fallback: fallback получает КАЖДЫЙ получатель,
      // и его место проверяется у каждого вхождения проверкой fallback не из
      // карты — без repeats и с поблажками по тексту самого fallback
      // (standInContextProblem, unmatchedFallback). Не к месту — оператор не
      // наполнится верно ни у кого: unbacked. Тема здесь не проверяется —
      // оператор темы без колонки уже в subjectUnresolved.
      if (!column && fallbackCounts && t.field === 'body' && !fallbackReported.has(key)) {
        const fallbackProblem = standInContextProblem(t, m.index, m.index + m[0].length, null, fallback);
        if (fallbackProblem) {
          unbacked.push({ ...where, operator, fallback, fallbackProblem });
          fallbackReported.add(key);
        }
      }
      // Пустые ячейки — у КАЖДОГО вхождения: место замены в тексте у каждого своё.
      if (!column || emptyReported.has(key)) continue;
      const cells = emptyOf(column);
      if (cells.empty === 0) continue;
      const base = { ...where, operator, column, emptyRows: cells.empty, rows: cells.rows };
      if (fallback === '') {
        emptyCells.push({ ...base, reason: 'no_stand_in' });
        emptyReported.add(key);
        continue;
      }
      // Fallback не из карты (его вид неизвестен) проверяется строже — как
      // существительное и без repeats (standInContextProblem без unmatchedFallback).
      const mapped = STAND_IN_BY_COLUMN_KEY.get(compactOperator(column));
      const standIn = mapped && mapped.phrase === fallback ? mapped : null;
      const reason = standInContextProblem(t, m.index, m.index + m[0].length, standIn);
      if (reason) {
        emptyCells.push({ ...base, reason, standIn: fallback });
        emptyReported.add(key);
      } else if (!standInByOperator.has(key)) {
        standInByOperator.set(key, { operator, column, standIn: fallback, emptyRows: cells.empty, rows: cells.rows });
      }
    }
    const rest = t.text.replace(operatorRe, ' ');
    for (const m of rest.matchAll(STRAY_BRACES_RE)) {
      malformed.push({ ...where, fragment: m[0].slice(0, 60) });
    }
  }

  return {
    ok: subjectUnresolved.length === 0 && unbacked.length === 0 && malformed.length === 0 && emptyCells.length === 0,
    subjectUnresolved,
    unbacked,
    malformed,
    emptyCells,
    standIns: [...standInByOperator.values()],
  };
}

/**
 * Отказ гейта, который не зависит от строк базы: оператор темы без колонки,
 * оператор без колонки и fallback или с fallback не к месту, битые скобки. Он
 * задевает КАЖДУЮ строку с адресом, какой бы она ни была (emptyCells — только
 * строки с пустой ячейкой). Одно определение на оба места, где так решают:
 * отбор строк ночного долива (stages/baseCollectRefill.ts, heRefillUnfilledRows)
 * и предпроверка писем тика до покупки сборки (autoPipeline.ts).
 */
export function heTemplateGateHoldsEveryRow(gate: HeTemplateOperatorGateResult): boolean {
  return gate.subjectUnresolved.length > 0 || gate.unbacked.length > 0 || gate.malformed.length > 0;
}

/* ── Бесплатная починка строки приветствия ── */

/**
 * Строка приветствия ЦЕЛИКОМ: приветствие + ровно один оператор + необязательный
 * знак. Якоря ^…$ на ОДНОЙ строке: строка с любым другим словом
 * («Hi {{firstName}}, quick question») не совпадает и не чинится.
 *  1 — отступ, 2 — приветствие, 3 — оператор, 4 — знак, 5 — \r (CRLF).
 */
const GREETING_LINE_RE = new RegExp(
  '^([ \\t]*)(hello|hi|hey|dear|greetings|good\\s+(?:morning|afternoon|evening|day))[ \\t]*,?[ \\t]*' +
    HE_OPERATOR_PATTERN +
    '[ \\t]*([,!.:;]?)[ \\t]*(\\r?)$',
  'i',
);

/**
 * Одна строка приветствия без имени. «Dear,» по-английски не читается — его
 * заменяет «Hello»; остальные приветствия остаются как написаны. Знак: «,», «!»
 * и «.» сохраняются, прочее (нет знака, «:», «;») → «,».
 */
function repairGreetingLine(line: string, hasColumn: (operator: string) => boolean): string | null {
  const m = GREETING_LINE_RE.exec(line);
  if (!m) return null;
  const operator = m[3] ?? '';
  if (!isHeNameOperator(operator) || hasColumn(operator)) return null;
  const greeting = /^dear$/i.test(m[2] ?? '') ? 'Hello' : (m[2] ?? '').replace(/\s+/g, ' ');
  const punct = m[4] === ',' || m[4] === '!' || m[4] === '.' ? m[4] : ',';
  return `${m[1] ?? ''}${greeting}${punct}${m[5] ?? ''}`;
}

/**
 * Текст → текст с починенной ПЕРВОЙ непустой строкой (или тот же текст).
 * Преобразование: split('\n') / join('\n') без потерь, меняется ровно один
 * элемент массива строк и только когда он совпал с GREETING_LINE_RE целиком.
 */
function repairText(text: string, hasColumn: (operator: string) => boolean): string {
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => l.trim() !== '');
  if (idx < 0) return text;
  const fixed = repairGreetingLine(lines[idx], hasColumn);
  if (fixed === null) return text;
  lines[idx] = fixed;
  return lines.join('\n');
}

interface RepairableLetter {
  body: string;
  variants?: Array<{ body: string }>;
  segment_variants?: Array<{ when: string; text: string }>;
}

/**
 * Бесплатная детерминированная починка, ограниченная СТРОКОЙ ПРИВЕТСТВИЯ:
 * в первой непустой строке тела (основного, каждого варианта и каждого
 * сегментного варианта) оператор с именем человека, у которого в базе нет
 * колонки (по маппингу — тому же, что прочтёт запуск), убирается:
 * «Hello {{firstName}},» → «Hello,». Темы, остальные строки и операторы с
 * колонкой не трогаются. Возвращает новые объекты писем (вход не мутирует) и
 * список починок; без починок — тот же массив.
 */
export function repairHeNameGreetings<L extends RepairableLetter>(
  letters: L[],
  columns: unknown,
  operatorMapping: unknown,
): { letters: L[]; repairs: HeGreetingRepair[] } {
  const resolve = makeResolver(columns, operatorMapping);
  const hasColumn = (operator: string) => resolve(operator).column !== null;
  const repairs: HeGreetingRepair[] = [];
  const firstLine = (text: string) => text.split('\n').find((l) => l.trim() !== '') ?? '';
  const fix = (text: string, at: Omit<HeGreetingRepair, 'before' | 'after'>): string => {
    const after = repairText(text, hasColumn);
    if (after !== text) repairs.push({ ...at, before: firstLine(text), after: firstLine(after) });
    return after;
  };

  const next = letters.map((letter, i) => {
    const n = i + 1;
    const body = fix(letter.body, { letter: n, variant: 'A' });
    const variants = letter.variants?.map((v) => {
      const vb = fix(v.body, { letter: n, variant: 'B' });
      return vb === v.body ? v : { ...v, body: vb };
    });
    const segments = letter.segment_variants?.map((s) => {
      const st = fix(s.text, { letter: n, variant: 'segment', segment: s.when });
      return st === s.text ? s : { ...s, text: st };
    });
    const changed =
      body !== letter.body ||
      (variants ?? []).some((v, vi) => v !== letter.variants?.[vi]) ||
      (segments ?? []).some((s, si) => s !== letter.segment_variants?.[si]);
    if (!changed) return letter;
    return {
      ...letter,
      body,
      ...(variants ? { variants } : {}),
      ...(segments ? { segment_variants: segments } : {}),
    } as L;
  });

  return { letters: repairs.length ? next : letters, repairs };
}

/* ── Текст причины (staff: лог стадии и he_jobs.error) ── */

function placeOf(issue: HeTemplateOperatorIssue): string {
  const variant =
    issue.variant === 'segment' ? `сегмент «${(issue.segment ?? '').slice(0, 40)}»` : `вариант ${issue.variant}`;
  return `письмо ${issue.letter}, ${variant}, ${issue.field === 'subject' ? 'тема' : 'тело'}`;
}

const EMPTY_CELL_REASON_RU: Record<Exclude<HeEmptyCellReason, 'no_stand_in'>, string> = {
  sentence_start: 'встала бы в начало предложения со строчной буквы',
  after_determiner: 'встала бы после артикля, местоимения или квантора («the your website», «each your company», «the local your area»)',
  glued: 'склеилась бы с соседним словом или адресом',
  greeting: 'встала бы в строку приветствия («Hi your company team»)',
  repeats: 'встала бы рядом со словом того же смысла («your site your website»)',
  modifier: 'встала бы определением перед словом («your area clinics»)',
};

/**
 * Короткая сводка гейта по-русски: её читает специалист (лог стадии и
 * he_jobs.error в /tools/hypothesis-engine). Клиенту она не уходит — проекция
 * кабинета не отдаёт he_jobs.error (clientEngProjection, JOB_FIELDS).
 */
export function describeHeTemplateOperatorGate(gate: HeTemplateOperatorGateResult, limit = 6): string {
  const parts = [
    ...gate.subjectUnresolved.map((i) => `${placeOf(i)}: {{${i.operator}}} без колонки базы (fallback в теме невозможен)`),
    // Оператор темы без колонки и без fallback стоит в обоих списках — в
    // сводке он один раз (строкой subjectUnresolved).
    ...gate.unbacked
      .filter((i) => i.field !== 'subject')
      .map((i) =>
        i.fallbackProblem
          ? `${placeOf(i)}: {{${i.operator}}} без колонки — подстановка «${i.fallback ?? ''}» уходит всем получателям и ${EMPTY_CELL_REASON_RU[i.fallbackProblem]}`
          : isHeNameOperator(i.operator ?? '')
            ? `${placeOf(i)}: {{${i.operator}}} — имени человека в базе нет`
            : `${placeOf(i)}: {{${i.operator}}} без колонки и без fallback`,
      ),
    ...gate.malformed.map((i) => `${placeOf(i)}: битый фрагмент «${i.fragment}»`),
    ...gate.emptyCells.map(
      (i) =>
        `${placeOf(i)}: {{${i.operator}}} — колонка «${i.column}» пуста у ${i.emptyRows} из ${i.rows} строк с адресом, ` +
        (i.reason === 'no_stand_in'
          ? 'а замены для такой колонки нет'
          : `а замена «${i.standIn ?? ''}» ${EMPTY_CELL_REASON_RU[i.reason]}`),
    ),
  ];
  const shown = parts.slice(0, limit).join('; ');
  return parts.length > limit ? `${shown}; и ещё ${parts.length - limit}` : shown;
}

/* ── Текст причины для модели (EN-генерация, подсказка повтора стадии template) ── */

function placeOfEn(issue: HeTemplateOperatorIssue): string {
  const where =
    issue.variant === 'segment'
      ? `email ${issue.letter}, segment version "${(issue.segment ?? '').slice(0, 40)}"`
      : `email ${issue.letter}${issue.variant === 'B' ? ' B' : ''}`;
  return `${where}, ${issue.field}`;
}

const EMPTY_CELL_REASON_EN: Record<Exclude<HeEmptyCellReason, 'no_stand_in'>, string> = {
  sentence_start: 'at the start of a sentence, where it would begin with a lowercase letter',
  after_determiner: 'after an article, determiner or quantifier ("the your website", "each your company", "the local your area")',
  glued: 'glued to the next or previous word, number or web address',
  greeting: 'in the greeting line ("Hi your company team")',
  repeats: 'next to a word with the same meaning ("your site your website")',
  modifier: 'in front of a noun it would have to describe ("your area clinics")',
};

/**
 * Проблемы гейта по-английски, по одной строке на проблему, с тем, что
 * исправить, — их стадия template кладёт в подсказку платного повтора по
 * операторам у EN-генерации (шаг 2d), чтобы этот повтор исправил ровно то, на
 * чём гейт отказал бы. Не больше `limit` строк, остаток — одной строкой.
 * Получатель и клиент этого текста не видят.
 */
export function heTemplateOperatorGateProblemsEn(gate: HeTemplateOperatorGateResult, limit = 12): string[] {
  const lines = [
    ...gate.subjectUnresolved.map(
      (i) => `${placeOfEn(i)}: {{${i.operator}}} has no column in the base, and a subject cannot use a fallback; remove it from the subject`,
    ),
    ...gate.unbacked
      .filter((i) => i.field !== 'subject')
      .map((i) =>
        i.fallbackProblem
          ? `${placeOfEn(i)}: {{${i.operator}}} has no column in the base, so every recipient gets "${i.fallback ?? ''}" in its place, and here it would sit ${EMPTY_CELL_REASON_EN[i.fallbackProblem]}; rewrite the sentence so "${i.fallback ?? ''}" reads right there, or remove the operator`
          : isHeNameOperator(i.operator ?? '')
            ? `${placeOfEn(i)}: {{${i.operator}}} is a person's name, and the base has no names; write the sentence without it`
            : `${placeOfEn(i)}: {{${i.operator}}} has no column in the base and no fallback; remove it`,
      ),
    ...gate.malformed.map(
      (i) => `${placeOfEn(i)}: "${i.fragment ?? ''}" is not a valid {{var}} operator; remove it or use an operator from the plan`,
    ),
    ...gate.emptyCells.map((i) =>
      i.reason === 'no_stand_in'
        ? `${placeOfEn(i)}: {{${i.operator}}} reads the "${i.column}" column, which is empty for ${i.emptyRows} of ${i.rows} recipients, and nothing can stand in for it; do not use this operator, and rewrite the sentence so it reads right without it`
        : `${placeOfEn(i)}: {{${i.operator}}} reads the "${i.column}" column, which is empty for ${i.emptyRows} of ${i.rows} recipients; they get "${i.standIn ?? ''}" instead, and here it would sit ${EMPTY_CELL_REASON_EN[i.reason]}; move the operator to a spot where "${i.standIn ?? ''}" reads right too (mid-sentence, for example after "at" or "for"), or remove it`,
    ),
  ];
  return lines.length > limit ? [...lines.slice(0, limit), `and ${lines.length - limit} more of the same kind`] : lines;
}

/* ── Колонки, которые модели лучше не показывать (стадия template, us) ── */

/**
 * Колонки базы, у которых есть пустая ячейка в строке С АДРЕСОМ (тот же счёт,
 * что у emptyCells) и нет замены по виду колонки (HE_STAND_INS): оператор по
 * такой колонке без fallback гейт отказывает (no_stand_in), а fallback модели
 * проверяется строго. Стадия template (us) убирает их из списка колонок,
 * который видит модель плана. Без rows или emailColumn — пустой список, как и
 * проверка emptyCells.
 */
export function heColumnsWithoutStandIn(input: {
  columns: unknown;
  rows?: unknown;
  emailColumn?: string | null;
}): string[] {
  const emptyOf = emptyCellCounter(input.rows, input.emailColumn);
  return asList(input.columns)
    .filter((c): c is string => typeof c === 'string')
    .filter((column) => heEmptyCellStandIn(column) === null && emptyOf(column).empty > 0);
}

/**
 * Шаблон us-проекта не прошёл гейт. Класс НЕ терминальный (дискриминанта
 * heJobTerminal нет): воркер повторит стадию по обычной политике (MAX_ATTEMPTS),
 * а повтор — это новая генерация писем, которая может пройти. Каждый повтор —
 * засчитанная попытка в тормозе писем (autopilotNext.heTemplateGenerationBudget),
 * так что за одно поколение анализа платных генераций не больше, чем пускает он.
 */
export class HeTemplateOperatorGateError extends Error {
  readonly code = 'unresolved_operators' as const;
  readonly gate: HeTemplateOperatorGateResult;

  constructor(gate: HeTemplateOperatorGateResult) {
    super(`Шаблон не допущен к отправке (подстановки без данных): ${describeHeTemplateOperatorGate(gate)}`);
    this.name = 'HeTemplateOperatorGateError';
    this.gate = gate;
  }
}
