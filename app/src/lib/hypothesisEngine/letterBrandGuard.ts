/**
 * Чужая компания в письмах клиента us-проекта.
 * ЧИСТЫЙ модуль: ни модели, ни сети. БД — только у двух чтений в конце
 * (readHeBrandEngClient, heBrandInputsBeforeEnqueue), и клиент БД они
 * получают аргументом: модуль не тянет за собой ни supabase, ни окружения.
 *
 * ЗАЧЕМ. Письма ENG-кабинета уходят из НАШИХ ящиков без человека, который их
 * прочёл бы, а пишет их модель. Письмо, в котором отправителем назван наш
 * бренд («At Polza we…», «The Polza team», «OutreachOS»), а клиент — другая
 * компания, говорит получателю неправду о том, кто пишет и что предлагают. Та
 * же неправда — вымышленная компания из примера EN-промпта писем
 * (HE_EN_EXAMPLE_SENDER и HE_EN_EXAMPLE_CASES ниже — их же подставляет
 * prompts/template.ts), если модель списала пример. Этот модуль —
 * детерминированная проверка того, что всё-таки написала модель.
 *
 * ЧТО СЧИТАЕТСЯ УТЕЧКОЙ (findHeBrandLeaks): отдельным словом, без учёта
 * регистра, в любой теме и любом теле писем (основной вариант, вариант B,
 * сегментные варианты; темы писем 2+ тоже — их видит клиент в превью):
 *  - наш бренд: «Polza» или «OutreachOS» («Polza Agency», «outreachOS»,
 *    «polza.agency» — тоже); kind 'brand';
 *  - имя вымышленной компании примера; kind 'example'.
 * Слово, которое — имя самого клиента, утечкой не считается (exempt):
 *  - любое из них — если оно отдельным словом стоит в имени компании из
 *    профиля сайта (brief.site_profile.company_name) или отдельной частью
 *    имени хоста его сайта («polza-dental.com» → «polza»; «napolzamed.com» —
 *    нет: «napolzamed» не «polza»);
 *  - имя из примера — ещё и если оно отдельным словом есть где угодно в
 *    брифе клиента (его поля, профиль сайта): тогда это его собственные слова,
 *    а не списанный пример. Наш бренд в полях брифа исключением НЕ делается —
 *    такой бриф ведёт к отказу до платных вызовов (heBrandInputLeaks ниже).
 *
 * КОГДА ПРОВЕРКА ВКЛЮЧЕНА (heLetterBrandGuard): рынок 'us', клиент
 * подтверждённо не мы, и одно из двух:
 *  - письма латиницей — английские или польские; ИЛИ
 *  - владелец проекта — клиент ENG-кабинета (profiles.role='client' и
 *    market='eng', readHeBrandEngClient; признак `heEngClient` строки
 *    проекта): его письма уходят из нашего пула без человека на ЛЮБОМ языке,
 *    и русские письма, которые сотрудник может сгенерировать его проекту в
 *    staff-инструменте, проверяются так же.
 * Не проверяются только русские письма проекта, владелец которого не клиент
 * ENG-кабинета (us-проект агентского клиента в staff-инструменте): роль и
 * пример RU-промпта зовут отправителя «Polza», и менять их нельзя — модель с
 * такой ролью проверке не переучить, повторы были бы оплачены впустую.
 * ОДНО ПРАВИЛО У СТАДИЙ И У ПУТЕЙ ОТПРАВКИ. Язык у стадий — язык цепочки
 * ('en' | 'pl' | 'ru'), на путях отправки, где лежат одни письма, —
 * heLettersLanguageOf по алфавиту ('ru' — кириллицы не меньше латиницы,
 * иначе 'en'). Польский по алфавиту от английского не отличить, поэтому он
 * проверяется и там, и там: стадия держит польские письма той же проверкой,
 * что и запуск, — иначе стадия сохраняла бы письма, которые запуск
 * откажет, и каждая следующая генерация платила бы за них снова. Цена
 * правила — у польской цепочки us-проекта агентского клиента (её пишет
 * RU-роль «Polza»): письма, назвавшие Polza, уходят в фикс-проход и повтор
 * стадии в пределах MAX_ATTEMPTS, а не в сохранение.
 * Наш ли клиент — ТОЛЬКО по хосту сайта (he_projects.website_url и снапшот
 * brief.website_url): точное совпадение с нашим доменом (OUR_SITE_DOMAINS) или
 * его поддоменом. Подстрока не в счёт: «napolzamed.com» — не мы. Хост наш →
 * проверки нет (Polza и OutreachOS — одна компания, наш проект вправе назвать
 * любой из двух брендов). Хост есть или есть имя компании, и хост не наш →
 * клиент подтверждённо не мы, проверка включена. Нет ни хоста, ни имени
 * компании → сравнивать не с чем ('unknown'): проверку не включаем, стадии
 * пишут это в лог. Рынок 'ru' не проверяется никогда.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Наши сайты: хост проекта, равный одному из них или его поддомену, — наш
 * проект. Список — домены, которые репозиторий называет нашими (порталы
 * polza-portal.ru и app.outreachos.pro, ENG-кабинет app.outreachos.xyz,
 * лендинги outreachos.pro / outreachos.xyz, почта и сайт polzaagency.ru /
 * polzaagency.com, почтовый сервер smtp.polzagency.ru). Домена, которого в
 * репозитории нет, здесь нет: лишний «наш» домен выключил бы проверку для
 * чужого клиента, а недостающий только включит её для нашего проекта.
 */
const OUR_SITE_DOMAINS = [
  'polza-portal.ru',
  'polzaagency.ru',
  'polzaagency.com',
  'polzagency.ru',
  'outreachos.pro',
  'outreachos.xyz',
] as const;

/** Наши бренды в письмах (в нижнем регистре). */
const OUR_BRAND_WORDS = ['polza', 'outreachos'] as const;

/**
 * Отправитель EN-примера писем (prompts/template.ts, LETTERS_SYSTEM_EN) —
 * вымышленная компания. Пример подставляет это имя отсюда, поэтому
 * проверка и пример разойтись не могут.
 */
export const HE_EN_EXAMPLE_SENDER = 'Vandelay';
/** Кейсы того же примера — тоже вымышленные компании. */
export const HE_EN_EXAMPLE_CASES = ['Initech', 'Hooli'] as const;

const EXAMPLE_WORDS = [HE_EN_EXAMPLE_SENDER, ...HE_EN_EXAMPLE_CASES].map((w) => w.toLowerCase());

/** Все проверяемые слова отдельным словом, без учёта регистра. */
const LETTER_WORD_RE = new RegExp(`\\b(?:${[...OUR_BRAND_WORDS, ...EXAMPLE_WORDS].join('|')})\\b`, 'gi');

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

/** Слово отдельным словом в тексте (без учёта регистра). Слова — только [a-z]. */
function hasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, 'i').test(text);
}

/** С чем сравниваются слова в письмах: хосты сайта и имена компании клиента. */
export interface HeSenderIdentity {
  hosts: string[];
  companyNames: string[];
}

/** Хост адреса сайта без «www.», в нижнем регистре; не адрес — null. */
function hostOf(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase();
    return host.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** Хост — наш сайт: точное совпадение с нашим доменом или его поддомен. */
export function heIsOurSiteHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return OUR_SITE_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Части имени хоста без зоны: «app.polza-dental.co» → app, polza, dental. */
function hostTokens(host: string): string[] {
  const labels = host.split('.');
  return labels.slice(0, Math.max(1, labels.length - 1)).flatMap((l) => l.split('-')).filter(Boolean);
}

/**
 * Личность отправителя по строке he_projects: хост сайта проекта (колонка и
 * снапшот брифа) и имя компании из профиля сайта. Строку читаем как есть
 * (jsonb брифа — форма не гарантирована).
 */
export function heSenderIdentityOf(project: { website_url?: unknown; brief?: unknown }): HeSenderIdentity {
  const brief = asRow(project.brief);
  const hosts = [asText(project.website_url), asText(brief?.website_url)]
    .map(hostOf)
    .filter((h): h is string => h !== null);
  const companyName = asText(asRow(brief?.site_profile)?.company_name).trim();
  return { hosts: [...new Set(hosts)], companyNames: companyName ? [companyName] : [] };
}

/** 'ours' — клиент это мы; 'not_ours' — подтверждённо не мы; 'unknown' — сравнивать не с чем. */
export type HeBrandOwnership = 'ours' | 'not_ours' | 'unknown';

export function heBrandOwnership(identity: HeSenderIdentity): HeBrandOwnership {
  if (identity.hosts.some(heIsOurSiteHost)) return 'ours';
  return identity.hosts.length || identity.companyNames.length ? 'not_ours' : 'unknown';
}

/**
 * Все строки jsonb (бриф) — сами значения, а не JSON-текст: в JSON перевод
 * строки пишется «\n», и слово в начале строки слиплось бы с буквой «n».
 */
function stringsOf(value: unknown, depth: number): string[] {
  if (typeof value === 'string') return [value];
  if (depth > 6 || !value || typeof value !== 'object') return [];
  const items = Array.isArray(value) ? value : Object.values(value as Row);
  return items.flatMap((v) => stringsOf(v, depth + 1));
}

/**
 * Слова, которые у ЭТОГО клиента утечкой не считаются (см. шапку,
 * «exempt»), — в нижнем регистре.
 */
function exemptWordsOf(identity: HeSenderIdentity, brief: unknown): string[] {
  const tokens = new Set(identity.hosts.flatMap(hostTokens));
  const names = identity.companyNames.join(' ');
  const briefText = stringsOf(brief, 0).join('\n');
  const own = (w: string) => tokens.has(w) || hasWord(names, w);
  return [
    ...OUR_BRAND_WORDS.filter(own),
    ...EXAMPLE_WORDS.filter((w) => own(w) || hasWord(briefText, w)),
  ];
}

/**
 * Строка проекта для проверки: сайт и бриф (как в he_projects) и признак
 * владельца. `heEngClient` — вычисленный, а не колонка: true — владелец
 * проекта клиент ENG-кабинета (readHeBrandEngClient), тогда проверка не
 * смотрит на язык писем. Нет признака — как у проекта не клиента
 * ENG-кабинета.
 */
export interface HeBrandProject {
  website_url?: unknown;
  brief?: unknown;
  heEngClient?: boolean;
}

/** Решение по проекту: включена ли проверка и чем подсказать модели. */
export interface HeLetterBrandGuard {
  /**
   * true — рынок 'us', клиент подтверждённо не мы, и письма латиницей
   * (английские, польские) или владелец — клиент ENG-кабинета (шапка).
   */
  active: boolean;
  ownership: HeBrandOwnership;
  /** Имя компании клиента из профиля сайта — для подсказки модели ('' — нет). */
  clientCompany: string;
  /** Слова, которые у этого клиента — его собственные (в нижнем регистре). */
  exempt: string[];
}

/**
 * `lettersLanguage` — язык писем: у стадий — язык цепочки ('en' | 'ru' |
 * 'pl'), на путях отправки — heLettersLanguageOf(письма шаблона). Выключает
 * проверку только 'ru' — и только у проекта, владелец которого не клиент
 * ENG-кабинета (`project.heEngClient`; шапка, «одно правило»).
 */
export function heLetterBrandGuard(
  market: string,
  project: HeBrandProject,
  lettersLanguage: string,
): HeLetterBrandGuard {
  if (market !== 'us') return { active: false, ownership: 'unknown', clientCompany: '', exempt: [] };
  const identity = heSenderIdentityOf(project);
  const ownership = heBrandOwnership(identity);
  return {
    active: ownership === 'not_ours' && (lettersLanguage !== 'ru' || project.heEngClient === true),
    ownership,
    clientCompany: identity.companyNames[0] ?? '',
    exempt: exemptWordsOf(identity, project.brief),
  };
}

/**
 * Язык готовых писем по алфавиту — для путей отправки, где на руках только
 * письма (he_templates без языка; цепочку вертикали с тех пор могли
 * перегенерировать на другом языке): кириллицы не меньше латиницы → 'ru',
 * иначе 'en'. Польские письма латиницей отсюда не отличить от английских —
 * и не нужно: польские проверяются везде, у стадий тоже (шапка).
 */
export function heLettersLanguageOf(letters: unknown): 'en' | 'ru' {
  let latin = 0;
  let cyrillic = 0;
  const count = (text: string) => {
    latin += (text.match(/[A-Za-z]/g) ?? []).length;
    cyrillic += (text.match(/[А-Яа-яЁё]/g) ?? []).length;
  };
  for (const raw of asList(letters)) {
    const letter = asRow(raw);
    if (!letter) continue;
    count(asText(letter.subject));
    count(asText(letter.body));
    for (const v of asList(letter.variants)) {
      count(asText(asRow(v)?.subject));
      count(asText(asRow(v)?.body));
    }
    for (const s of asList(letter.segment_variants)) count(asText(asRow(s)?.text));
  }
  return cyrillic > 0 && cyrillic >= latin ? 'ru' : 'en';
}

/** Одно упоминание чужой компании в тексте письма. */
export interface HeBrandLeak {
  /** 1-based номер письма. */
  letter: number;
  /** A — основной текст, B — вариант письма (variants[]), segment — сегментный вариант. */
  variant: 'A' | 'B' | 'segment';
  field: 'subject' | 'body';
  /** Условие сегмента — у variant 'segment'. */
  segment?: string;
  /** Слово, как оно написано в письме («Polza», «outreachOS», «Vandelay»). */
  brand: string;
  /** 'brand' — наш бренд; 'example' — вымышленная компания примера промпта. */
  kind: 'brand' | 'example';
}

/**
 * Все упоминания проверяемых слов в письмах, кроме `exempt` (слова в нижнем
 * регистре), — без решения «наш ли проект» (его принимает heLetterBrandGuard).
 * Вход — письма как в he_chains/he_templates (subject, body, variants[],
 * segment_variants[]); одно упоминание на слово и текст.
 */
export function findHeBrandLeaks(letters: unknown, exempt: readonly string[] = []): HeBrandLeak[] {
  const out: HeBrandLeak[] = [];
  const skip = new Set(exempt.map((w) => w.toLowerCase()));
  const scan = (text: string, at: Omit<HeBrandLeak, 'brand' | 'kind'>) => {
    const seen = new Set<string>();
    for (const m of text.matchAll(LETTER_WORD_RE)) {
      const key = m[0].toLowerCase();
      if (seen.has(key) || skip.has(key)) continue;
      seen.add(key);
      out.push({ ...at, brand: m[0], kind: (OUR_BRAND_WORDS as readonly string[]).includes(key) ? 'brand' : 'example' });
    }
  };
  asList(letters).forEach((raw, i) => {
    const letter = asRow(raw);
    if (!letter) return;
    const n = i + 1;
    scan(asText(letter.subject), { letter: n, variant: 'A', field: 'subject' });
    scan(asText(letter.body), { letter: n, variant: 'A', field: 'body' });
    for (const rawVariant of asList(letter.variants)) {
      const v = asRow(rawVariant);
      if (!v) continue;
      scan(asText(v.subject), { letter: n, variant: 'B', field: 'subject' });
      scan(asText(v.body), { letter: n, variant: 'B', field: 'body' });
    }
    for (const rawSegment of asList(letter.segment_variants)) {
      const s = asRow(rawSegment);
      if (!s) continue;
      scan(asText(s.text), { letter: n, variant: 'segment', field: 'body', segment: asText(s.when) });
    }
  });
  return out;
}

/** Утечки для этого проекта: пусто, если проверка не включена. */
export function heLetterBrandLeaks(guard: HeLetterBrandGuard, letters: unknown): HeBrandLeak[] {
  return guard.active ? findHeBrandLeaks(letters, guard.exempt) : [];
}

/**
 * Решение путей отправки по ГОТОВЫМ письмам шаблона (ядро запуска, ночной
 * долив и тик крона до его покупки, переиспользование шаблона стадией,
 * признак `needs_rewrite` кабинета — он же гейт старта отправки): язык — по
 * письмам (heLettersLanguageOf), остальное — как у стадий, и `heEngClient`
 * строки проекта решает так же (вызывающий читает его readHeBrandEngClient,
 * когда heBrandNeedsOwner(письма) — иначе ответ от него не зависит). Пусто —
 * отправлять можно.
 */
export function heTemplateBrandLeaks(market: string, project: HeBrandProject, letters: unknown): HeBrandLeak[] {
  return heLetterBrandLeaks(heLetterBrandGuard(market, project, heLettersLanguageOf(letters)), letters);
}

/**
 * Меняет ли признак владельца (`heEngClient`) ответ heTemplateBrandLeaks по
 * этим письмам: только у русских писем (по алфавиту), в которых есть хоть одно
 * проверяемое слово. Иначе профиль владельца читать незачем.
 */
export function heBrandNeedsOwner(letters: unknown): boolean {
  return heLettersLanguageOf(letters) === 'ru' && findHeBrandLeaks(letters).length > 0;
}

/* ── Поля брифа клиента: отказ до платных вызовов ── */

/** Поля брифа, которые промпты писем берут ДОСЛОВНО (prompts/chain.ts). */
export const HE_BRAND_INPUT_FIELDS = ['signature_override', 'offer_override', 'business_override'] as const;
export type HeBrandInputField = (typeof HE_BRAND_INPUT_FIELDS)[number];

/** Наш бренд в поле брифа клиента. */
export interface HeBrandInputLeak {
  field: HeBrandInputField;
  /** Слово, как оно написано в поле. */
  brand: string;
}

/**
 * Наш бренд в полях брифа, которые промпт велит вставить дословно: подпись
 * отправителя (в конец каждого письма), оффер и описание бизнеса (слова
 * клиента — «verbatim» у EN-промптов). Проверка включена (guard.active) и
 * слово не имя самого клиента — тогда письма с этим полем не пройдут проверку
 * никогда: промпт требует слово, проверка его запрещает, и каждый оплаченный
 * прогон стадии кончится тем же отказом. Имена вымышленных компаний примера
 * сюда не входят: в брифе клиента они — его собственные слова (exempt).
 */
export function heBrandInputLeaks(guard: HeLetterBrandGuard, brief: unknown): HeBrandInputLeak[] {
  if (!guard.active) return [];
  const row = asRow(brief);
  const skip = new Set(guard.exempt);
  const out: HeBrandInputLeak[] = [];
  for (const field of HE_BRAND_INPUT_FIELDS) {
    const text = asText(row?.[field]);
    const seen = new Set<string>();
    for (const m of text.matchAll(LETTER_WORD_RE)) {
      const key = m[0].toLowerCase();
      if (!(OUR_BRAND_WORDS as readonly string[]).includes(key) || skip.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ field, brand: m[0] });
    }
  }
  return out;
}

/** Подпись поля на шаге 1 кабинета (EngStepBrief.tsx) — для текстов клиенту. */
const INPUT_FIELD_LABEL_EN: Record<HeBrandInputField, string> = {
  signature_override: 'Sender signature',
  offer_override: 'Offer override',
  business_override: 'Business description',
};

/** Подпись поля на шаге 1 кабинета (EngStepBrief.tsx); не поле брифа — null. */
export function heBrandInputFieldLabelEn(field: unknown): string | null {
  return typeof field === 'string' && Object.prototype.hasOwnProperty.call(INPUT_FIELD_LABEL_EN, field)
    ? INPUT_FIELD_LABEL_EN[field as HeBrandInputField]
    : null;
}

/**
 * Подпись поля для staff (по-русски): подпись на шаге 1 «Исследование»
 * staff-инструмента (steps/Step1Research.tsx) и имя поля брифа — его же
 * кабинет называет на шаге 1 «Your business» (INPUT_FIELD_LABEL_EN).
 */
const INPUT_FIELD_LABEL_RU: Record<HeBrandInputField, string> = {
  signature_override: '«Отправитель (подпись в письмах)» (signature_override, в кабинете «Sender signature»)',
  offer_override: '«Оффер» (offer_override, в кабинете «Offer override»)',
  business_override: '«Описание бизнеса» (business_override, в кабинете «Business description»)',
};

function listEn(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Английский текст отказа клиенту: какое поле шага 1 называет наш бренд и как
 * его поправить. Поля и кнопка — те, что на шаге 1 «Your business»
 * (раскрывающийся блок «What we know about your business», карточка с полями
 * и кнопкой «Save overrides», EngStepBrief.tsx). `then` — кнопка, которую
 * нажать после правки (её называет вызывающий: «Rewrite letters» у роута
 * переписки, «Launch» у «Launch» шага 3). Карточка рынка шага 3 пишет то же
 * своими словами (engText.ts, engLettersBrandInputText) по списку полей
 * проекции.
 */
export function heBrandInputRefusalEn(inputs: HeBrandInputLeak[], then: string): string {
  const fields = [...new Set(inputs.map((i) => i.field))];
  const words = [...new Set(inputs.map((i) => i.brand))];
  const fieldText = listEn(fields.map((f) => `«${INPUT_FIELD_LABEL_EN[f]}»`));
  const wordText = listEn(words.map((w) => `"${w}"`));
  return (
    `Your ${fieldText} on step 1 ${fields.length > 1 ? 'name' : 'names'} ${wordText}, ` +
    `${words.length > 1 ? 'brands that are' : 'a brand that is'} not your company. ` +
    'Letters go out on behalf of your company, so they are not written while that text is there. ' +
    `On step 1 «Your business», open «What we know about your business», remove ${wordText} from ${fieldText} ` +
    `and press «Save overrides», then ${then}.`
  );
}

/** Отказ «Rewrite letters» (api/client/eng/templates/[id]/rewrite). */
export function heBrandInputRewriteRefusalEn(inputs: HeBrandInputLeak[]): string {
  return heBrandInputRefusalEn(inputs, 'press «Rewrite letters» again');
}

/* ── Тексты: подсказка модели и причина для специалиста ── */

/**
 * Пункты для подсказки модели (фикс-проход и повтор стадии): одна строка на
 * упоминание, по-английски для 'en', иначе по-русски. Модель получает и что
 * убрать, и о ком писать вместо этого — о компании клиента и её собственном
 * предложении из материалов.
 */
export function heBrandLeakFixItems(
  leaks: HeBrandLeak[],
  language: string,
  clientCompany: string,
): Array<{ detail: string }> {
  const en = language === 'en';
  const company = clientCompany.trim();
  return leaks.map((l) => {
    const tag =
      l.variant === 'segment'
        ? en
          ? `letter ${l.letter}, segment variant "${(l.segment ?? '').slice(0, 40)}"`
          : `письмо ${l.letter}, сегментный вариант «${(l.segment ?? '').slice(0, 40)}»`
        : `${en ? 'letter' : 'письмо'} ${l.letter}${l.variant}${l.field === 'subject' ? (en ? ', subject' : ', тема') : ''}`;
    if (l.kind === 'example') {
      return {
        detail: en
          ? `${tag}: names "${l.brand}", a made-up company from an example, not a company from the materials; remove "${l.brand}": the emails are sent by the client company${company ? ` (${company})` : ''}, so write about it and its own offer, and name only companies that the materials name`
          : `${tag}: назван «${l.brand}» — вымышленная компания из примера, её нет в материалах; убери «${l.brand}»: письма отправляет компания клиента${company ? ` (${company})` : ''}, пиши про неё и её собственное предложение и называй только компании из материалов`,
      };
    }
    return {
      detail: en
        ? `${tag}: names "${l.brand}", but the emails are sent by the client company${company ? ` (${company})` : ''}, not by "${l.brand}"; remove "${l.brand}" and write that part about the client company and its own offer from the materials`
        : `${tag}: назван «${l.brand}», но письма отправляет компания клиента${company ? ` (${company})` : ''}, а не «${l.brand}» — убери «${l.brand}» и напиши эту часть про компанию клиента и её собственное предложение из материалов`,
    };
  });
}

/**
 * Короткая сводка по-русски: лог стадии, he_jobs.error, отказ запуска для
 * staff и причина алерта долива (их читает специалист; клиенту проекция
 * кабинета he_jobs.error не отдаёт). Только номер письма, место и слово — ни
 * текста письма, ни условия сегмента: по he_jobs.error кабинет выбирает
 * причину остановки (classifyHeClientError), и слово модели вроде «warm-up» в
 * условии сегмента увело бы её не туда.
 */
export function describeHeBrandLeaks(leaks: HeBrandLeak[], limit = 6): string {
  const parts = leaks.map((l) => {
    const variant = l.variant === 'segment' ? 'сегментный вариант' : `вариант ${l.variant}`;
    const word = l.kind === 'example' ? `«${l.brand}» (компания из примера промпта)` : `«${l.brand}»`;
    return `письмо ${l.letter}, ${variant}, ${l.field === 'subject' ? 'тема' : 'тело'}: ${word}`;
  });
  const shown = parts.slice(0, limit).join('; ');
  return parts.length > limit ? `${shown}; и ещё ${parts.length - limit}` : shown;
}

/**
 * Письма us-проекта называют чужую компанию, а клиент подтверждённо не мы:
 * стадия их не записывает. Класс НЕ терминальный (дискриминанта heJobTerminal
 * нет), как HeTemplateOperatorGateError: воркер повторит стадию по обычной
 * политике (MAX_ATTEMPTS), повтор — новая генерация писем, которая может
 * пройти.
 */
export class HeLetterBrandLeakError extends Error {
  readonly code = 'brand_leak' as const;
  readonly leaks: HeBrandLeak[];

  constructor(stage: 'chain' | 'template', leaks: HeBrandLeak[]) {
    super(
      `${stage === 'chain' ? 'Цепочка не сохранена' : 'Шаблон не допущен к отправке'} ` +
        `(в письмах назван наш бренд или компания из примера промпта, а клиент проекта — другая компания): ${describeHeBrandLeaks(leaks)}`,
    );
    this.name = 'HeLetterBrandLeakError';
    this.leaks = leaks;
  }
}

/** Сводка полей брифа с нашим брендом — для staff. */
export function describeHeBrandInputLeaks(inputs: HeBrandInputLeak[]): string {
  return inputs.map((i) => `${INPUT_FIELD_LABEL_RU[i.field]}: «${i.brand}»`).join('; ');
}

/* ── Бесплатный отказ в строке джобы ── */

/**
 * Ключ пометки в he_jobs.payload: строку закрыл отказ, в котором не было ни
 * одного платного вызова (воркер, writeJobFailure). Значение —
 * HE_JOB_UNPAID_BRAND_INPUT; рядом — поля и слова (HE_JOB_BRAND_INPUTS_KEY),
 * чтобы письмо клиенту назвало поле.
 */
export const HE_JOB_UNPAID_REFUSAL_KEY = 'unpaid_refusal';
export const HE_JOB_UNPAID_BRAND_INPUT = 'brand_input' as const;
export const HE_JOB_BRAND_INPUTS_KEY = 'brand_inputs';

/**
 * Поле брифа, которое промпт берёт дословно, называет наш бренд, а клиент
 * подтверждённо не мы (heBrandInputLeaks): стадия отказывает ДО первого
 * платного вызова. Класс ТЕРМИНАЛЬНЫЙ (дискриминант heJobTerminal читает
 * воркер): повтор с тем же брифом кончился бы тем же отказом. И БЕСПЛАТНЫЙ
 * (дискриминант heUnpaidRefusal): воркер не засчитывает такому прогону
 * попытку и метит строку джобы (HE_JOB_UNPAID_REFUSAL_KEY в payload), а
 * читатели бюджетов писем такую строку прогоном не считают
 * (heJobUnpaidBrandInput). Сюда доходит только бриф, поправленный ПОСЛЕ
 * постановки: каждый путь постановки проверяет те же поля до неё
 * (heBrandInputsBeforeEnqueue). После правки поля новая джоба — обычная
 * генерация, и бюджет писем у неё тот же, что был до этих отказов: они его не
 * тратят (исчерпать его могут только платные прогоны).
 *
 * Текст — he_jobs.error, его читает сотрудник (staff-инструмент, алерт
 * остановки рынка); клиенту кабинет его не отдаёт. Совет сначала: запись
 * режет текст до 500 символов, и обрезан будет хвост списка полей, а не он.
 */
export class HeLetterBrandInputError extends Error {
  /** Дискриминант: instanceof ложен, если в бандле окажется две копии модуля. */
  readonly heJobTerminal = true as const;
  /** Дискриминант бесплатного отказа (воркер: попытку не засчитывать, строку пометить). */
  readonly heUnpaidRefusal = HE_JOB_UNPAID_BRAND_INPUT;
  readonly code = 'brand_input' as const;
  readonly inputs: HeBrandInputLeak[];

  constructor(stage: 'chain' | 'template', inputs: HeBrandInputLeak[]) {
    super(
      `${stage === 'chain' ? 'Цепочка не генерировалась' : 'Шаблон не генерировался'}: поле брифа называет наш ` +
        'бренд, а клиент проекта — другая компания (вызовов модели не было; попытка и бюджет писем не засчитаны). ' +
        'Поправить поле — у клиента ENG-кабинета он сам на шаге 1 «Your business», у проекта staff-инструмента ' +
        `сотрудник на шаге 1 «Исследование», — и поставить генерацию заново: ${describeHeBrandInputLeaks(inputs)}`,
    );
    this.name = 'HeLetterBrandInputError';
    this.inputs = inputs;
  }
}

/**
 * Отказ — бесплатный отказ за наш бренд в поле брифа (по дискриминанту, не по
 * классу: отказ, восстановленный воркером из файла брошенных строк, —
 * простой Error с теми же примитивными полями, и списка полей у него может не
 * быть). null — не он.
 */
export function heBrandInputRefusalOf(error: unknown): { inputs: HeBrandInputLeak[] } | null {
  const e = error as { heUnpaidRefusal?: unknown; inputs?: unknown } | null;
  if (!e || typeof e !== 'object' || e.heUnpaidRefusal !== HE_JOB_UNPAID_BRAND_INPUT) return null;
  return { inputs: brandInputsOf(e.inputs) };
}

function brandInputsOf(raw: unknown): HeBrandInputLeak[] {
  return asList(raw).flatMap((item) => {
    const row = asRow(item);
    const field = row?.field;
    const brand = asText(row?.brand);
    return heBrandInputFieldLabelEn(field) !== null && brand ? [{ field: field as HeBrandInputField, brand }] : [];
  });
}

/**
 * Пометка бесплатного отказа в payload строки he_jobs: поля брифа (может быть
 * пустой список — поля потерялись), или null — строка не помечена. Её читают
 * все читатели бюджетов писем: тормоз генераций (autopilotNext,
 * heTemplateGenerationBudget), ночной гейт «цепочка уже падала»
 * (autopilotReconcile) — и письмо об остановке рынка (engClientMail).
 */
export function heJobUnpaidBrandInput(payload: unknown): HeBrandInputLeak[] | null {
  const row = asRow(payload);
  if (row?.[HE_JOB_UNPAID_REFUSAL_KEY] !== HE_JOB_UNPAID_BRAND_INPUT) return null;
  return brandInputsOf(row[HE_JOB_BRAND_INPUTS_KEY]);
}

/* ── Чтения (клиент БД — аргументом) ── */

/**
 * Кто владелец проекта: 'eng_client' — клиент ENG-кабинета
 * (profiles.role='client' и market='eng': то же правило, что у
 * readHeEngSendingAccess и чтения владельца автопилота); 'other' — нет
 * владельца (пустой created_by: кабинета у такого проекта нет), профиля
 * владельца нет (у клиента ENG-кабинета профиль есть всегда — без него он
 * не войдёт), другой профиль или колонки market нет (42703: ENG-клиентов быть
 * не может); 'unknown' — чтение не удалось. НЕ БРОСАЕТ.
 */
export async function readHeProjectOwnerKind(
  db: SupabaseClient,
  ownerId: unknown,
): Promise<'eng_client' | 'other' | 'unknown'> {
  if (typeof ownerId !== 'string' || ownerId.length === 0) return 'other';
  try {
    const { data, error } = await db.from('profiles').select('role, market').eq('id', ownerId).maybeSingle();
    if (error) return (error as { code?: unknown }).code === '42703' ? 'other' : 'unknown';
    const row = (data ?? null) as { role?: unknown; market?: unknown } | null;
    if (!row) return 'other';
    return row.role === 'client' && row.market === 'eng' ? 'eng_client' : 'other';
  } catch {
    return 'unknown';
  }
}

/**
 * Признак `heEngClient` для HeBrandProject (readHeProjectOwnerKind). Не
 * знаем ('unknown') — true: из двух ошибок эта проверяет письма на любом языке
 * (держит письмо), а не пропускает их. НЕ БРОСАЕТ.
 */
export async function readHeBrandEngClient(db: SupabaseClient, ownerId: unknown): Promise<boolean> {
  return (await readHeProjectOwnerKind(db, ownerId)) !== 'other';
}

/**
 * Язык, на котором стадия template напишет письма вертикали: язык самой новой
 * строки he_chains вертикали (как берёт её стадия, stages/template.ts) —
 * 'en' | 'pl', иначе 'ru'. Цепочки нет — 'ru' (стадия тогда откажет сама, до
 * платных вызовов). Сбой чтения — бросает: «не знаю» — не «русский».
 */
export async function readHeVerticalLettersLanguage(db: SupabaseClient, verticalId: string): Promise<string> {
  const { data, error } = await db
    .from('he_chains')
    .select('language')
    .eq('vertical_id', verticalId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`he_chains language read: ${error.message}`);
  const language = (data as { language?: unknown } | null)?.language;
  return language === 'en' || language === 'pl' ? language : 'ru';
}

/**
 * ПРЕДПРОВЕРКА ДО ПОСТАНОВКИ генерации писем — цепочки или итоговых писем:
 * какие поля брифа стадия отказала бы (HeLetterBrandInputError) тем же
 * правилом, что у стадии. Каждый путь постановки зовёт её до вставки джобы
 * и отказывает сам (бесплатно, с текстом про поле шага 1); стадия ловит только
 * бриф, поправленный после постановки.
 *  - `project` — строка he_projects с website_url, brief и created_by;
 *  - `language` — язык генерации, если он известен (цепочка: язык, с которым
 *    её ставят); у итоговых писем не передаётся — тогда, если владелец не
 *    клиент ENG-кабинета, язык читается у самой новой цепочки вертикали
 *    (`verticalId`, readHeVerticalLettersLanguage).
 * Чтения — только когда поля брифа вообще называют наш бренд: профиль
 * владельца, затем (не ENG-клиент, язык не задан) язык цепочки. Сбой чтения
 * языка бросает — вызывающий отвечает своим путём «не прочитали».
 */
export async function heBrandInputsBeforeEnqueue(
  db: SupabaseClient,
  args: {
    market: string;
    project: { website_url?: unknown; brief?: unknown; created_by?: unknown };
    language?: string;
    verticalId?: string;
  },
): Promise<HeBrandInputLeak[]> {
  const { market, project } = args;
  // Латиница — самый широкий случай: пусто здесь — пусто при любом языке и владельце.
  const widest = heBrandInputLeaks(heLetterBrandGuard(market, { ...project, heEngClient: true }, 'en'), project.brief);
  if (widest.length === 0) return [];
  const heEngClient = await readHeBrandEngClient(db, project.created_by);
  if (heEngClient) return widest;
  const language =
    args.language ?? (args.verticalId ? await readHeVerticalLettersLanguage(db, args.verticalId) : 'en');
  return heBrandInputLeaks(heLetterBrandGuard(market, { ...project, heEngClient }, language), project.brief);
}
