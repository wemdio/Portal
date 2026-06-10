/**
 * Shared name-quality predicates for the customers / integrations extractors.
 *
 * The DOM heuristics are deliberately lenient when *collecting* candidates;
 * these predicates are the precision filter. Anything that looks like a CMS
 * image hash, a design-tool export artifact, a nav/CTA label or a marketing
 * service name is rejected so the LLM fallback can take over instead.
 */

const VOWEL_RE = /[aeiouyаеёиоуыэюя]/i;

/**
 * Random CMS/Tilda image basenames look like `ayvervdk9wrpaqde6begp6jfmg`
 * or hex blobs like `3abc4d6a3ca0dabbed3`. Real company names are short,
 * contain spaces, or both — never a long digit-bearing single token.
 */
export function isHashLike(s: string): boolean {
  const t = s.trim();
  if (!t || /\s/.test(t)) return false; // multi-word → not a hash
  if (/^[0-9a-f]{8,}$/i.test(t)) return true; // pure hex blob
  if (t.length >= 14 && /\d/.test(t)) return true; // long token with a digit
  if (t.length >= 24) return true; // implausibly long single word
  return false;
}

const DESIGN_ARTIFACT_RE: RegExp[] = [
  /^\d*\s*сло[йяе]\s*\d*$/i, // Photoshop "1 Слой 5" layer exports
  /^layer\s*\d*$/i,
  /^frame[\s\d]+$/i, // Figma "Frame 2 6 1"
  /^group\s*\d*$/i,
  /^rectangle\s*\d*$/i,
  /^(?:dummy|placeholder|noimage|untitled|default)\b/i,
  /^slogan\b/i,
  /^slide\s*\d*$/i,
  /^partner\s*\d*$/i, // alt="partner1"
  /^client\s*\d*$/i,
  /^logo\s*\d*$/i,
  /^icons?(?:\s|\d|$)/i, // "icon 1 redrawn", "icon", "icon2"
  /^shape(?:\s|\d|$)/i, // bare "shape" + "shape 4"
  /^\d+\s*(?:место|place)$/i, // "6 место" ranking badges
  /^pay\s+(?:icon|arrow)$/i,
];

export function isDesignArtifact(s: string): boolean {
  const t = s.trim();
  return DESIGN_ARTIFACT_RE.some((re) => re.test(t));
}

const CTA_PREFIX_RE =
  /^(?:подробн|читат|посмотрет|смотрет|узнат|скачат|отправ|обсуд|оставит|связат|напиш|подписат|подписк|зарегистр|регистрац|гаранти|преимуществ|политик|цен[аы]|стоимост)/i;

const NAV_EXACT = new Set<string>([
  'меню', 'главная', 'контакты', 'контакт', 'о нас', 'о компании', 'обо мне',
  'команда', 'вакансии', 'вакансия', 'работа у нас', 'отзывы', 'отзыв', 'faq',
  'блог', 'новости', 'услуги', 'наши услуги', 'тарифы', 'тариф', 'стоимость',
  'преимущества', 'карьера', 'войти', 'регистрация',
  'политика конфиденциальности', 'согласие на обработку данных',
  'все новости', 'все кейсы', 'все проекты',
  // section headings that can leak into client name extraction
  'клиенты', 'наши клиенты', 'партнёры', 'партнеры', 'наши партнёры', 'наши партнеры',
  'нам доверяют', 'они выбрали нас', 'с нами работают',
  'clients', 'our clients', 'customers', 'our customers', 'partners', 'trusted by',
  // CTA / legal boilerplate that appears after client logos
  'send', 'отправить', 'подробнее', 'узнать больше', 'все клиенты', 'all clients',
  // ─── Industrial-sector noise (МОСЛИФТ, БГЭМ, КАСКАД-ЭНЕРГО feedback 09.06)
  //
  // Contact-form buttons that sit RIGHT NEXT to logos in modal popups on the
  // promka sites — they leak into customers when the form is inside a class
  // we treat as a client container.
  'закрыть', 'отмена', 'прикрепить файл', 'прикрепить', 'отправить файл',
  'выбрать файл', 'выберите файл', 'обзор', 'browse', 'cancel', 'close',
  // Carousel/slider navigation labels — Tilda/Bitrix sites carry these as
  // alt text on the prev/next buttons, which then count as a "logo" in the
  // logo wall.
  'previous slide', 'next slide', 'previous', 'next', 'предыдущий', 'следующий',
  'предыдущий слайд', 'следующий слайд',
  // Section headings observed leaking into customers on industrial sites
  // — they sit inside a `<div class="news">` container that other selectors
  // ALSO match as a customers wall.
  'актуальные новости', 'последние новости', 'вниманию акционеров',
  'для акционеров', 'для инвесторов', 'для прессы', 'архив новостей',
  'все события', 'наши достижения', 'события компании',
]);

export function isNavOrCtaText(s: string): boolean {
  const t = s.trim().toLowerCase().replace(/[!.…]+$/, '').trim();
  if (!t) return true;
  if (CTA_PREFIX_RE.test(t)) return true;
  if (NAV_EXACT.has(t)) return true;
  return false;
}

const SERVICE_RE =
  /(?:контекстн|таргетир|медийн|нативн|наружн)[а-я]*\s+реклам|\bseo\b|\bsmm\b|перформанс|веб-?аналитик|email-?маркетинг|контент-?маркетинг|интернет-?маркетинг|digital[\s-]?маркетинг|интернет-?реклам|управлени[ея]\s+репутаци|\bserm\b|разработк[аи]\s+(?:и\s+редизайн\s+)?сайт|редизайн\s+сайт|аудит\s+и\s+анализ|комплексн\w*\s+маркетинг|лидогенерац/i;

/**
 * Service/offering phrases leak from "что мы делаем" blocks and case
 * descriptions: "реклама в яндекс директ", "настройка сквозной аналитики",
 * "внедрение битрикс24", "создание сайтов на тильде". They start with an
 * action noun rather than naming a client.
 */
const SERVICE_PREFIX_RE =
  /^(?:настройк|внедрени|создани[ея]|разработк|ведени|продвижени|интеграци|сопровожд|поддержк|обслуживани|автоматизаци|съёмк|съемк|монтаж|брендинг|ребрендинг|упаковк|консалтинг|аутсорсинг|аутстаффинг|аудит|оптимизаци|реклама?\s+в\s|сайт)/i;

export function isServiceText(s: string): boolean {
  const t = s.trim();
  return SERVICE_RE.test(t) || SERVICE_PREFIX_RE.test(t);
}

/**
 * Numeric / statistic fragments leaking from case cards and pricing blocks:
 * "456 обращений в месяц", "1184,25 ₽", "Количество заявок33", "∼3",
 * "5 000 - 7 000 ₽", "535 млн рублей", "20+". A real company name never carries
 * a currency sign, a percentage, a count unit, or is purely numeric. The unit
 * list is only consulted when a digit is present, so brands like "2ГИС", "1С"
 * or "7ЦВЕТОВ-ДЕКОР" are safe.
 */
// NOTE: no `\b` anchors — JS word boundaries are ASCII-only and never match at
// a Cyrillic/space edge. These units are only consulted when a digit is present
// (see isMetricText), so plain substring matching is safe enough.
const METRIC_UNIT_RE =
  /₽|руб|\$|€|%|обращени|заяв|лид[аыовей]|месяц|млн|млрд|тыс|конверси|выручк|оборот|трафик/i;

export function isMetricText(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (/^[~∼]/.test(t)) return true; // "∼3", "~26057,96 ₽"
  if (/^[\d\s.,+%–—()-]+$/.test(t)) return true; // "20+", "5 000 - 7 000", "01."
  if (/[₽$€%]/.test(t)) return true; // any currency / percent sign
  if (/\d/.test(t) && METRIC_UNIT_RE.test(t)) return true;
  return false;
}

/**
 * Form field labels from "карточка клиента" / brief blocks: "Среднегодовая
 * выручка:", "CRM:", "Сайт:", "Брендбук: нет". Either ends in a colon or is a
 * "label: short value" pair — never a company name.
 */
const FORM_LABEL_RE =
  /[A-Za-zА-Яа-яЁё)\]][:：]\s*(?:нет|да|есть|n\/?a|данных\s+нет|[\d.,\s+₽%–—-]*)$/i;

export function isFormLabel(s: string): boolean {
  const t = s.trim();
  if (t.length < 2) return false;
  return t.endsWith(':') || t.endsWith('：') || FORM_LABEL_RE.test(t);
}

/**
 * Job/role titles from testimonials and job listings: "генеральный директор
 * ООО …", "Начальник отдела продаж", "Customer Service Representative",
 * "Фронтенд-разработчик". Matches role NOUNS (not bare adjectives) so company
 * names like "Финансовая Корпорация" are not caught.
 */
// Matched against individual lower-cased tokens (so declensions like
// "директора"/"менеджеров" are caught) — `\b` would not work around Cyrillic.
const ROLE_STEM_RE =
  /^(?:директор|руководител|начальник|менеджер|владел|учредител|основател|маркетолог|бухгалтер|аналитик|разработчик|программист|дизайнер|инженер|специалист|консультант|режисс[её]р|нутрициолог|таргетолог|ceo|cto|cmo|cfo|coo|founder|cofounder|owner|manager|director|representative|associate|officer|specialist|developer|designer)/i;

export function isRoleTitle(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (/head\s+of\s/.test(t)) return true;
  const tokens = t.split(/[\s.,()«»"'/\\-]+/).filter(Boolean);
  return tokens.some((w) => ROLE_STEM_RE.test(w));
}

/**
 * Article / FAQ titles and marketing sentences: "Что такое AI маркетинг?",
 * "Как определить целевую аудиторию бизнеса", "Мы уже решили …". Company names
 * are short noun phrases — they never start with an interrogative, carry a
 * question mark, or run past five words.
 */
const SENTENCE_STARTER_RE =
  /^(?:как|что|почему|зачем|когда|где|чем|сколько|каки[ехй]|какой|какая|кто|how|what|why|when|where|who)(?=\s|\?|$)/i;

// Russian function words (prepositions / conjunctions). A real company name is
// a noun phrase and almost never carries one of these *between* its tokens
// ("Вся команда В одном месте", "График активности И скорость ответа"); a
// descriptive feature/benefit phrase or marketing claim does. Only consulted
// for phrases of 3+ whitespace tokens and never in the leading position, so
// brands like "О'КЕЙ" (one token) or "Точка Роста" (no connective) are safe.
const RU_CONNECTIVES = new Set<string>([
  'в', 'во', 'и', 'с', 'со', 'на', 'для', 'от', 'по', 'из', 'за', 'к', 'ко',
  'о', 'об', 'у', 'что', 'как', 'или', 'чтобы', 'при', 'про', 'под', 'над',
  'без', 'до', 'внутри', 'через', 'между', 'около', 'чем',
]);

export function isSentenceLike(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (/\?/.test(t)) return true; // questions → article/FAQ titles
  if (SENTENCE_STARTER_RE.test(t)) return true; // "Как ...", "Что такое ..."
  const words = t.split(/\s+/);
  if (words.length > 5) return true; // company names are short
  if (words.length >= 4 && /[.…!]$/.test(t)) return true; // sentence-ending copy
  // Feature/benefit phrases: 3+ tokens with a Russian connective in a
  // non-initial slot — "Защита контента и безопасность данных".
  if (words.length >= 3) {
    for (let i = 1; i < words.length; i++) {
      if (RU_CONNECTIVES.has(words[i].toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * Industry / market-segment labels that get listed alongside (or instead of)
 * client logos: "Медицина", "FinTech", "Ритейл", "B2B опт". These belong in the
 * case_industries column, never in customers/integrations.
 */
const INDUSTRY_EXACT = new Set<string>([
  'медицина', 'медицина и фарма', 'фарма', 'фармацевтика', 'образование',
  'строительство', 'строительство и недвижимость', 'недвижимость', 'ритейл',
  'ритейл и e-commerce', 'e-commerce', 'ecommerce', 'финансы', 'финансы и банки',
  'банки', 'промышленность', 'логистика', 'логистика и транспорт', 'транспорт',
  'энергетика', 'телеком', 'госсектор', 'агробизнес', 'сельское хозяйство',
  'сельское хозяйство и апк', 'апк', 'нко', 'общепит', 'horeca', 'хорека',
  'инжиниринг', 'производство', 'маркетинг и реклама', 'it и saas', 'саас', 'saas',
  'fintech', 'edtech', 'medtech', 'beautytech', 'autotech', 'foodtech', 'proptech',
  'fmcg', 'b2b', 'b2c', 'b2b опт', 'digital', 'hr', 'it', 'адтех', 'adtech',
  'автомобильный', 'автомобили', 'отрасли', 'отрасль', 'industries', 'sectors',
]);

export function isIndustryOrSector(s: string): boolean {
  return INDUSTRY_EXACT.has(s.trim().toLowerCase());
}

/**
 * City / region / country labels that leak from office-location lines and
 * job-board listings ("Москва", "Нью-Йорк", "Соединённые Штаты Америки",
 * "Калифорния"). A geographic place is not a client company. Exact-match on
 * the whole string, so wrapped brands like "Банк «Санкт-Петербург»" or
 * "Банк России" survive (the bare token is never equal to the full name).
 */
const PLACE_EXACT = new Set<string>([
  // RU cities
  'москва', 'санкт-петербург', 'спб', 'екатеринбург', 'новосибирск', 'казань',
  'нижний новгород', 'краснодар', 'ростов-на-дону', 'сочи', 'самара', 'уфа',
  'пермь', 'воронеж', 'волгоград', 'владивосток', 'челябинск', 'омск', 'тула',
  'тверь', 'калининград', 'иркутск', 'красноярск',
  // CIS / world cities
  'минск', 'киев', 'алматы', 'астана', 'ташкент', 'дубай', 'дублин', 'нью-йорк',
  'сан-франциско', 'лондон', 'париж', 'берлин', 'амстердам', 'варшава',
  // regions / states
  'огайо', 'калифорния', 'техас', 'флорида', 'невада', 'монтенегро', 'черногория',
  // countries
  'россия', 'рф', 'сша', 'соединённые штаты америки', 'соединенные штаты америки',
  'украина', 'беларусь', 'казахстан', 'узбекистан', 'германия', 'франция',
  'великобритания', 'китай', 'индия', 'оаэ',
]);

const PLACE_PREFIX_RE = /^(?:агломерация|город|г\.|область|регион)\s/i;

export function isPlaceName(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (PLACE_EXACT.has(t)) return true;
  if (PLACE_PREFIX_RE.test(t)) return true;
  return false;
}

/**
 * Street-address fragments that leak from footer / contact blocks: "Крылатская
 * ул.", "корп.", "проспект Мира". The street-type token sits at the end (with
 * an optional building number) — a company name never ends in "ул."/"корп.".
 */
const ADDRESS_RE =
  /(?:^|\s)(?:ул|улица|проспект|просп|пр-?кт|корпус|корп|бульвар|бул|шоссе|набережная|наб|переулок|пер)\.?\s*\d*$/i;

export function isAddressLike(s: string): boolean {
  return ADDRESS_RE.test(s.trim());
}

/**
 * Personal names from testimonials/reviews: "Татьяна", "Инна Сафронова",
 * "Жуков Виталий Андреевич", "Timur Gilmanov". The reviewer is a person, not a
 * client company. Detection is conservative: a single known given name, a
 * "Given Surname" pair, or a three-token ФИО with a patronymic.
 */
const GIVEN_NAMES = new Set<string>([
  // male
  'александр', 'алексей', 'анатолий', 'андрей', 'антон', 'артём', 'артем', 'борис',
  'вадим', 'валентин', 'валерий', 'василий', 'виктор', 'виталий', 'владимир',
  'владислав', 'вячеслав', 'геннадий', 'георгий', 'григорий', 'даниил', 'денис',
  'дмитрий', 'евгений', 'егор', 'иван', 'игорь', 'илья', 'кирилл', 'константин',
  'лев', 'леонид', 'максим', 'михаил', 'никита', 'николай', 'олег', 'павел',
  'пётр', 'петр', 'роман', 'руслан', 'семён', 'семен', 'сергей', 'станислав',
  'степан', 'тарас', 'тимур', 'фёдор', 'федор', 'эдуард', 'юрий', 'ярослав', 'азиз',
  // female
  'алёна', 'алена', 'алина', 'анастасия', 'анна', 'валентина', 'вера', 'вероника',
  'виктория', 'галина', 'дарья', 'диана', 'екатерина', 'елена', 'инна', 'ирина',
  'кристина', 'ксения', 'лариса', 'любовь', 'людмила', 'маргарита', 'марина',
  'мария', 'надежда', 'наталья', 'наталия', 'оксана', 'ольга', 'полина',
  'светлана', 'софия', 'софья', 'татьяна', 'юлия', 'яна',
  // latin
  'dmitry', 'dmitriy', 'eugene', 'timur', 'kirill', 'lucy', 'michael', 'john',
  'david', 'alex', 'anna', 'maria', 'ivan', 'sergey', 'andrey', 'oleg',
]);

const PATRONYMIC_RE = /(?:ович|евич|ьевич|овна|евна|ьевна|инична)$/i;

export function isPersonName(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  const tokens = t.split(/\s+/);
  if (tokens.length < 1 || tokens.length > 3) return false;
  const lower = tokens.map((w) => w.toLowerCase().replace(/[.,]/g, ''));
  if (tokens.length === 1) return GIVEN_NAMES.has(lower[0]);
  const allWords = tokens.every((w) => /^[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё’'-]+$/.test(w));
  if (!allWords) return false;
  if (tokens.length === 2) return GIVEN_NAMES.has(lower[0]) || GIVEN_NAMES.has(lower[1]);
  // 3 tokens → ФИО only if it has both a given name and a patronymic
  const hasGiven = lower.some((w) => GIVEN_NAMES.has(w));
  const hasPatronymic = tokens.some((w) => PATRONYMIC_RE.test(w));
  return hasGiven && hasPatronymic;
}

/**
 * UI/CSS-class fragments and generic category words that leak from logo-wall
 * alt-texts and `<span class="...">` labels into integrations/customers:
 *   "hero img", "blue circle color", "material symbols light mail",
 *   "Read more", "Why choose us", bare "analytics" / "services" / "integration"
 *   / "teamwork", category labels like "SaaS / IT", "HR / Рекрутинг".
 * A real product or client name is never one of these.
 */
const UI_FRAGMENT_PATTERNS: RegExp[] = [
  // 2-word "<role/region> <ui-noun>" CSS fragments turned into alt text.
  /^(?:hero|about|main|side|nav|footer|header|content|wrap|wrapper|container|inner|outer|primary|secondary)\s+(?:img|image|icon|wrap|item|block|section|box|bg|background)$/i,
  // Material/Fluent icon family class names.
  /^material\s+symbols\b/i,
  /^fa[-\s]/i, // FontAwesome leaks like "fa solid envelope"
  // "<color> <shape> <ui-noun>" — pure CSS-class-as-alt artifacts.
  /^(?:blue|red|green|yellow|orange|purple|pink|black|white|gray|grey|dark|light|brown|cyan|magenta)\s+(?:circle|square|triangle|line|dot|bar|stripe|gradient|wave|bg|background)\s+(?:color|bg|background|shape|fill|stroke)$/i,
  // Inline icon descriptors like "img logo", "icon close", "btn arrow".
  /^(?:img|icon|btn|button|arrow|chevron|cross|close|menu|burger|hamburger)\s+\w+$/i,
  // "<noun> <ui-modifier>" — "Sidebar image", "arrow link white", "slider2",
  // "ff 2 new" / "inst new" / "children" — leak from logo wall alt-texts on
  // small RU sites built on Tilda/WP. The leading token is a generic-UI noun
  // and the trailing tokens are color/size/state modifiers.
  /^(?:sidebar|hero|banner|footer|header|nav|slide|slider|carousel|item|tile|card|block|section|column|row|box|widget|button|btn|link)\s+(?:image|img|icon|wrap|item|block|section|box|bg|background|white|black|gray|dark|light|new|old|alt|main|big|small|big1|big2|big3|small1|small2)$/i,
  // "<ui-noun> <digit>" — "slider2", "banner3", "section 1", "block 2"
  /^(?:slider|slide|carousel|banner|hero|section|item|tile|card|block|tab|row|col|column|page|step|stage|widget|popup|modal|menu|nav|button|btn)\s*\d{1,2}$/i,
  // "<colour-or-state> <single-word>" without contextual noun:
  // "white logo", "black icon" — CSS variants of generic icons.
  /^(?:white|black|gray|grey|dark|light|colored|color|new|old|big|small|main|alt)\s+(?:logo|icon|img|image|button|btn|arrow|chevron|line|dot|circle|square|bar)$/i,
  // RU/EN slide/page numbering: "Слайд 3", "Slide 12", "Страница 2".
  // Industrial sites lean on plain Tilda carousels where these are alt-texts
  // on the dots and arrows.
  /^(?:слайд|slide|страница|page|пункт|item|шаг|step)\s+\d{1,3}$/i,
];

/**
 * Single-token lowercase ASCII fragments that leak from CMS slug-classes
 * ("kras", "perek", "ver", "audifon", "bezugliy") — they look like Russian
 * transliterations or partial brand truncations but lack any structure of a
 * real product name. A real brand:
 *   - mixes case ("amoCRM", "Roistat"), or
 *   - is single-language all-caps ("YOLA"), or
 *   - contains a digit ("1С", "24/7"), or
 *   - uses non-Latin chars (Cyrillic, etc.), or
 *   - is a multi-word phrase ("Mango Office").
 *
 * The pattern `[a-z]{2,8}` lowercase with NO digits / non-ASCII / mixed case
 * captures the CMS-slug variant and rejects it. Real lowercase brands like
 * "amocrm" / "slack" / "stripe" are short but recognisable English/IT words —
 * caller can whitelist by adding to a known-brands set if needed. Empirically,
 * the LOWERCASE single-token slug-style noise has a ~90% false-positive rate
 * for "is this a real integration".
 */
const LOWERCASE_SLUG_RE = /^[a-z]{2,8}$/;
const KNOWN_LOWERCASE_BRANDS = new Set<string>([
  'amocrm', 'roistat', 'mindbox', 'sendpulse', 'unisender', 'mailchimp',
  'slack', 'stripe', 'shopify', 'paypal', 'bitrix', 'tilda', 'wix',
  'ozon', 'yandex', 'avito', 'lamoda', 'wildberries', 'rutube', 'vk',
  'tinkoff', 'sber', 'mts', 'megafon', 'beeline', 'tele2',
  'github', 'gitlab', 'bitbucket', 'figma', 'notion', 'trello',
  'asana', 'jira', 'discord', 'zoom', 'webex', 'skype', 'whatsapp',
  'telegram', 'viber', 'instagram', 'facebook', 'twitter', 'linkedin',
  'youtube', 'tiktok', 'pinterest', 'reddit', 'medium', 'dribbble',
]);

export function isLowercaseSlugNoise(s: string): boolean {
  const t = s.trim();
  if (!LOWERCASE_SLUG_RE.test(t)) return false;
  if (KNOWN_LOWERCASE_BRANDS.has(t)) return false;
  return true;
}

// Single-word generic UI / tech-category words. Never a real product or client.
const GENERIC_TERM_EXACT = new Set<string>([
  // English tech-category nouns
  'analytics', 'integration', 'integrations', 'service', 'services',
  'teamwork', 'workflow', 'automation', 'platform', 'platforms', 'cloud',
  'product', 'products', 'features', 'feature', 'pricing', 'documentation',
  'docs', 'support', 'help', 'search', 'login', 'signin', 'sign-in',
  'signup', 'sign-up', 'register', 'subscribe', 'newsletter',
  // UI containers
  'banner', 'overlay', 'modal', 'dialog', 'tooltip', 'sidebar', 'navbar',
  'header', 'footer', 'content', 'wrapper', 'container', 'section',
  'block', 'card', 'cards', 'tile', 'tiles', 'grid', 'list',
  // Generic CTAs / actions
  'read', 'more', 'view', 'show', 'hide', 'toggle', 'open', 'close',
  'next', 'prev', 'previous', 'submit', 'send', 'cancel', 'ok',
  'yes', 'no',
  // Section headings missed elsewhere
  'hero', 'about', 'contact', 'home', 'main',
  // Decorative icons / arrows / shapes used as alt text (observed in xlsx
  // 04.06: "arrow", "akciya", "slider2", "food", "kras", "perek", "ver").
  'arrow', 'arrows', 'chevron', 'caret', 'star', 'stars', 'plus', 'minus',
  'check', 'checkmark', 'circle', 'dot', 'square', 'line', 'wave', 'shape',
  'slider', 'slide', 'carousel', 'logo', 'logos', 'image', 'images',
  'photo', 'photos', 'pic', 'pics', 'preview', 'thumbnail',
  'food', 'akciya', 'akcia', 'banner1', 'banner2', 'banner3',
]);

// Multi-word generic UI strings: marketing section headings and CTA copy.
const GENERIC_PHRASE_EXACT = new Set<string>([
  'why choose us', 'who we are', 'what we do', 'how we work',
  'our work', 'our services', 'our team', 'our story', 'our mission',
  'read more', 'view all', 'view more', 'show more', 'see all',
  'see more', 'learn more', 'find out more', 'get started',
  'sign in', 'sign up', 'log in', 'log out',
  'free trial', 'start free', 'try now', 'try free',
  'все услуги', 'все товары', 'все категории', 'смотреть все',
  'смотреть всё', 'показать все', 'показать всё', 'показать ещё',
  'показать еще', 'свернуть', 'развернуть',
]);

// Category labels like "SaaS / IT", "HR / Рекрутинг", "B2B / B2C" — slash-
// separated lists of category words. These describe market segments, not
// products. The token on either side must be short (≤ 16 chars), start with
// a letter, and the slash itself must carry whitespace on both sides — so
// brands with an embedded slash like "AC/DC" never match.
const CATEGORY_SLASH_RE =
  /^[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9&\s]{0,16}\s+\/\s+[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9&\s]{0,20}$/;

// Ranking-list prefixes from "Топ-30 ..." articles: "1 AKAR", "3 Mospoliteh",
// "23 RKS Group". The leading digit token is the list position, not part of
// the brand. Real brands with a leading digit (1С, 7ЦВЕТОВ-ДЕКОР, 36.6) never
// have a SPACE between the digit and the rest, so the whitespace guard
// preserves them.
const RANKING_PREFIX_RE = /^\d{1,3}\s+[A-Za-zА-Яа-яЁё]/;

// Common form-table column headers that leak from "Бриф клиента" / "Карточка"
// pages into the clients column: "Клиент", "Клиника", "Параметр", "Описание".
// These are field labels, not company names.
const TABLE_HEADER_EXACT = new Set<string>([
  'клиент', 'клиника', 'параметр', 'описание', 'наименование', 'название',
  'характеристика', 'значение', 'категория', 'тип', 'статус', 'комментарий',
  'примечание', 'тариф', 'продукт', 'товар', 'отрасль', 'индустрия',
  'сфера', 'сегмент', 'регион', 'локация', 'дата', 'период', 'количество',
  'сумма', 'цена', 'цвет', 'размер', 'формат',
]);

// Marketing benefit/feature phrases that start with a Russian adjective stem.
// "Выгодная стоимость", "Круглосуточное обслуживание", "Удобный сервис" —
// the agency's own offering, never a client. Two tokens are typical, so the
// generic isSentenceLike (which needs 3+) misses them. JS `\w` is ASCII-only
// so the token-2 anchor must spell the Cyrillic class explicitly.
const FEATURE_BENEFIT_STEM_RE =
  /^(?:выгодн|удобн|профессиональн|качественн|гарантированн|эффективн|круглосуточн|надёжн|надежн|быстр|оперативн|индивидуальн|комплексн|современн|инновационн|уникальн|стабильн|опытн|экспертн|кастомн|клиентоориентированн)[а-яё]*\s+[А-Яа-яЁёA-Za-z]/i;

// Photo/avatar filenames seen as alt text on testimonial blocks: "mikh fresh2",
// "kate fin" — short lowercase first-name-ish token followed by a known CMS
// status suffix ("fresh"/"fin"/"new"/"old"/...) and an optional digit. Real
// lowercase product names like "amocrm" / "salesforce" / "slack" are single
// tokens and never carry these status suffixes, so they are safe.
const PHOTO_FILENAME_RE =
  /^[a-z]{2,12}\s+(?:fresh|fin|finish|new|old|done|main|logo|big|small|sm|md|lg|temp|tmp|copy|edit|final|orig|prev|next|v)\d{0,2}$/i;

export function isUiFragment(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  const lower = t.toLowerCase();
  if (GENERIC_TERM_EXACT.has(lower)) return true;
  if (GENERIC_PHRASE_EXACT.has(lower)) return true;
  if (TABLE_HEADER_EXACT.has(lower)) return true;
  // Single-token CMS-slug noise ("kras", "perek", "audifon") — rejected
  // unless it's a known lowercase brand (amocrm / slack / stripe / ...).
  if (isLowercaseSlugNoise(t)) return true;
  if (UI_FRAGMENT_PATTERNS.some((re) => re.test(t))) return true;
  if (CATEGORY_SLASH_RE.test(t)) return true;
  if (RANKING_PREFIX_RE.test(t)) return true;
  if (FEATURE_BENEFIT_STEM_RE.test(t)) return true;
  return false;
}

/**
 * Multi-token lowercase CMS photo filenames like "mikh fresh2", "kate fin" —
 * testimonial / team avatars exposed via alt text. Restricted to the
 * "<short-name> <status-suffix>" pattern so single-word lowercase brands
 * like "amocrm" / "salesforce" / "slack" are not affected.
 */
export function isPhotoFilename(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 24) return false;
  if (/[A-ZА-ЯЁ]/.test(t)) return false; // any uppercase → not a CMS-style file slug
  return PHOTO_FILENAME_RE.test(t);
}

/**
 * Multi-token CMS gibberish: "a1 4bf9 ad ebcab", "7f9baf a1 4bf9". Every token
 * is a short hex blob and at least one carries a digit (so real words built
 * only from a–f letters like "cafe" or "ada" are left alone).
 */
export function isMostlyHexTokens(s: string): boolean {
  const tokens = s.trim().split(/\s+/);
  if (tokens.length < 2) return false;
  if (!/\d/.test(s)) return false;
  return tokens.every((t) => /^[0-9a-f]{1,8}$/i.test(t));
}

/** A candidate good enough to be *positively* counted as a real name. */
export function isPlausibleName(s: string): boolean {
  const t = s.trim();
  if (t.length < 2) return false;
  if (
    isHashLike(t) || isDesignArtifact(t) || isNavOrCtaText(t) || isServiceText(t) ||
    isMetricText(t) || isFormLabel(t) || isRoleTitle(t) || isSentenceLike(t) ||
    isIndustryOrSector(t) || isPersonName(t) || isMostlyHexTokens(t) ||
    isPlaceName(t) || isAddressLike(t) || isUiFragment(t) || isPhotoFilename(t)
  ) return false;
  if (/\s/.test(t)) {
    const words = t.split(/\s+/);
    return words.length <= 5 && t.length <= 50;
  }
  // single token: must read like a word, not a leftover slug
  if (t.length > 22) return false;
  return VOWEL_RE.test(t);
}

/**
 * Processor-level trust gate: decide whether a heuristic name list is good
 * enough to keep, or should be dropped so the LLM fallback runs instead.
 * A list is trusted when a majority of its entries look like real names.
 */
export function nameListLooksReal(names: string[]): boolean {
  if (names.length === 0) return false;
  const plausible = names.filter(isPlausibleName).length;
  return plausible >= Math.ceil(names.length / 2);
}
