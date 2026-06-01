/** @jest-environment node */

import {
  isHashLike,
  isDesignArtifact,
  isNavOrCtaText,
  isServiceText,
  isMetricText,
  isFormLabel,
  isRoleTitle,
  isSentenceLike,
  isIndustryOrSector,
  isPersonName,
  isMostlyHexTokens,
  isPlaceName,
  isAddressLike,
  isUiFragment,
  isPlausibleName,
  nameListLooksReal,
} from '@/lib/enrich/extractors/nameQuality';

// Real-world garbage observed in the "Сигналы" output spreadsheet — these are
// the exact noise classes the heuristic extractors used to leak into the
// "Клиенты" and "Интеграции" columns.
const CMS_HASHES = [
  'ayvervdk9wrpaqde6begp6jfmg',
  'rhj4ne9qcsw3fxjhixceuvnucsxwjv',
  'odv2ua3vitkm3jm1edk2yuvkykyjaz',
  '3abc4d6a3ca0dabbed3',
  'ee3ccb6fe4beb0bb6fee',
];

const DESIGN_ARTIFACTS = ['partner1', 'partner2', '1 Слой 5', 'Frame 2 6 1 1', 'dummy', '6 место'];
const NAV_CTA = ['Работа у нас', 'Отзывы', 'О компании', 'FAQ', 'Скачать нашу презентацию', 'Подробнее о нас', 'Цена в месяц от'];
const SERVICES = [
  'Аудит и анализ', 'Контекстная реклама', 'Медийная реклама', 'Контент-маркетинг',
  // marketing-discipline labels that are the agency's own offering, not a client
  'Интернет-маркетинг', 'Digital-маркетинг', 'интернет-реклама',
  // service/offering phrases that start with an action noun
  'реклама в яндекс директ', 'настройка сквозной аналитики', 'внедрение битрикс24',
  'создание сайтов на тильде', 'аутсорсинг отдела продаж',
];

// City / region / country labels — geography is never a client company.
const PLACES = [
  'Москва', 'Нью-Йорк', 'Соединённые Штаты Америки', 'Соединенные Штаты Америки',
  'Калифорния', 'Дублин', 'Огайо', 'Сан-Франциско', 'Агломерация Джэксонвилла',
];
// Footer / contact-block address fragments.
const ADDRESSES = ['Крылатская ул.', 'корп.', 'Садовая улица', 'Кутузовский просп.'];
// Product feature / benefit phrases with a Russian connective in the middle.
const FEATURE_PHRASES = [
  'Вся команда в одном месте', 'График активности и скорость ответа',
  'Рабочий чат с привычным функционалом', 'Защита контента и безопасность данных',
  'Отраслевая экспертиза в 50+ нишах', 'Разные роли внутри команды',
];

// Statistic fragments from case cards and pricing tables.
const METRICS = [
  '456 обращений в месяц', '1184,25 ₽', 'Количество заявок33', '∼3',
  '5 000 - 7 000 ₽', '535 млн рублей', '20+', '— 95 обращений', 'Обращений в месяц: 635',
];
// Brief / client-card form field labels.
const FORM_LABELS = [
  'Среднегодовая выручка:', 'CRM:', 'Сайт:', 'Соцсети:', 'Брендбук: нет',
  'Каналы коммуникации:', 'Качество обработки лидов:',
];
// Testimonial author roles and job-listing titles.
const ROLE_TITLES = [
  'генеральный директор ООО «Перегородки в офис»', 'Начальник отдела продаж',
  'Customer Service Representative', 'Фронтенд-разработчик',
  'Chief Business Development Officer', 'owner of LABBU Beauty Salon',
  'Финансовый аналитик', 'Менеджер маркетплейсов',
];
// Blog / FAQ article titles and marketing sentences.
const ARTICLE_TITLES = [
  'Что такое AI маркетинг?', 'Как определить целевую аудиторию бизнеса',
  'В чем разница между AEO и GEO?', 'Что такое технический аудит сайта',
  'ТОП-10 курсов по интернет-маркетингу в 2026 году',
];
// Market-segment labels that belong in case_industries, not customers.
const INDUSTRIES = ['Медицина', 'FinTech', 'Ритейл', 'B2B', 'Производство', 'Логистика', 'Отрасли', 'SaaS'];
// Reviewer personal names — people, not client companies.
const PERSON_NAMES = [
  'Татьяна', 'Инна Сафронова', 'Жуков Виталий Андреевич', 'Timur Gilmanov',
  'Мария Антонова', 'Тарас Алтунин', 'Азиз',
];
// Multi-token CMS gibberish.
const HEX_TOKEN_JUNK = ['a1 4bf9 ad ebcab', '7f9baf a1 4bf9'];

// CSS-class fragments leaked into alt attributes, generic UI words, and
// "X / Y" category labels — all observed in the spreadsheet noise rows.
const UI_FRAGMENTS = [
  // CSS-class-as-alt artifacts
  'hero img', 'about img', 'main bg', 'header background', 'wrapper item',
  'blue circle color', 'red circle color', 'green circle background',
  'material symbols light mail', 'material symbols outlined send',
  'fa solid envelope', 'fa-brands telegram',
  'icon close', 'btn arrow', 'img logo',
  // Generic tech-category single words
  'analytics', 'integration', 'integrations', 'services', 'service',
  'teamwork', 'workflow', 'automation', 'platform', 'cloud',
  // Generic UI / nav single words
  'banner', 'overlay', 'modal', 'sidebar', 'header', 'footer',
  'subscribe', 'newsletter', 'login', 'signup',
  // Marketing section headings
  'Why choose us', 'What we do', 'Our services', 'Our team',
  'Read more', 'View all', 'Show more', 'Learn more',
  // Category labels with slash
  'SaaS / IT', 'HR / Рекрутинг', 'B2B / B2C', 'Digital / Performance',
];

const REAL_NAMES = [
  'Газпром нефть', 'Росбанк', 'Сколково', 'Samsung', 'Metro', 'amoCRM', 'mindbox', 'Тинькофф',
  // real clients observed in the spreadsheet — must never be flagged as noise
  'Банк России', 'Альфа Страхование', 'ВТБ Лизинг', 'Рив Гош', 'Лемана ПРО',
  'VMware', 'Dell EMC', 'BOCONCEPT ONLINE', 'JUGru Group', '7ЦВЕТОВ-ДЕКОР',
];

describe('nameQuality predicates', () => {
  it('flags CMS image-hash slugs', () => {
    for (const h of CMS_HASHES) expect(isHashLike(h)).toBe(true);
  });

  it('does not flag real company names as hashes', () => {
    for (const n of REAL_NAMES) expect(isHashLike(n)).toBe(false);
  });

  it('flags design-tool export artifacts', () => {
    for (const a of DESIGN_ARTIFACTS) expect(isDesignArtifact(a)).toBe(true);
  });

  it('flags nav/CTA labels', () => {
    for (const t of NAV_CTA) expect(isNavOrCtaText(t)).toBe(true);
  });

  it('flags marketing service names', () => {
    for (const s of SERVICES) expect(isServiceText(s)).toBe(true);
  });

  it('flags numeric / statistic fragments', () => {
    for (const m of METRICS) expect(isMetricText(m)).toBe(true);
  });

  it('flags brief-form field labels', () => {
    for (const f of FORM_LABELS) expect(isFormLabel(f)).toBe(true);
  });

  it('flags testimonial roles and job-listing titles', () => {
    for (const r of ROLE_TITLES) expect(isRoleTitle(r)).toBe(true);
  });

  it('flags article / FAQ titles and sentences', () => {
    for (const a of ARTICLE_TITLES) expect(isSentenceLike(a)).toBe(true);
  });

  it('flags industry / market-segment labels', () => {
    for (const i of INDUSTRIES) expect(isIndustryOrSector(i)).toBe(true);
  });

  it('flags reviewer personal names', () => {
    for (const p of PERSON_NAMES) expect(isPersonName(p)).toBe(true);
  });

  it('flags multi-token CMS hex gibberish', () => {
    for (const h of HEX_TOKEN_JUNK) expect(isMostlyHexTokens(h)).toBe(true);
  });

  it('flags CSS-class fragments, generic UI words and category labels', () => {
    for (const f of UI_FRAGMENTS) expect(isUiFragment(f)).toBe(true);
  });

  it('does not flag real product/integration names as UI fragments', () => {
    // Google Analytics is a real product; bare "analytics" is not — and the
    // brand prefix is what keeps the heuristic safe.
    const realProducts = [
      'Google Analytics', 'Битрикс24', 'amoCRM', 'Roistat', 'JivoSite',
      'Slack', 'Calendly', 'Mango Office', 'ЮKassa', 'CloudPayments',
      'Wildberries', 'Ozon', 'Lamoda',
    ];
    for (const p of realProducts) expect(isUiFragment(p)).toBe(false);
  });

  it('flags city / region / country labels', () => {
    for (const p of PLACES) expect(isPlaceName(p)).toBe(true);
  });

  it('flags street-address fragments', () => {
    for (const a of ADDRESSES) expect(isAddressLike(a)).toBe(true);
  });

  it('flags product feature / benefit phrases via connectives', () => {
    for (const f of FEATURE_PHRASES) expect(isSentenceLike(f)).toBe(true);
  });

  it('does not flag real names as metrics, roles, industries or people', () => {
    for (const n of REAL_NAMES) {
      expect(isMetricText(n)).toBe(false);
      expect(isFormLabel(n)).toBe(false);
      expect(isRoleTitle(n)).toBe(false);
      expect(isSentenceLike(n)).toBe(false);
      expect(isIndustryOrSector(n)).toBe(false);
      expect(isPersonName(n)).toBe(false);
      expect(isPlaceName(n)).toBe(false);
      expect(isAddressLike(n)).toBe(false);
    }
  });

  it('keeps real company names plausible', () => {
    for (const n of REAL_NAMES) expect(isPlausibleName(n)).toBe(true);
  });

  it('rejects every noise class as not plausible', () => {
    for (const junk of [
      ...CMS_HASHES, ...DESIGN_ARTIFACTS, ...NAV_CTA, ...SERVICES,
      ...METRICS, ...FORM_LABELS, ...ROLE_TITLES, ...ARTICLE_TITLES,
      ...INDUSTRIES, ...PERSON_NAMES, ...HEX_TOKEN_JUNK,
      ...PLACES, ...ADDRESSES, ...FEATURE_PHRASES, ...UI_FRAGMENTS,
    ]) {
      expect(isPlausibleName(junk)).toBe(false);
    }
  });
});

describe('nameListLooksReal trust gate', () => {
  it('distrusts a junk-heavy list so the LLM fallback can run', () => {
    expect(nameListLooksReal([...SERVICES, ...CMS_HASHES])).toBe(false);
  });

  it('trusts a clean list of real names', () => {
    expect(nameListLooksReal(REAL_NAMES)).toBe(true);
  });

  it('distrusts a real-world junk row (metrics + roles + titles) so the LLM runs', () => {
    // Exactly the kind of garbage the "Клиенты" column used to keep.
    const junkRow = [
      'Что такое AI маркетинг?', 'реклама в яндекс директ', 'Среднегодовая выручка:',
      'Медицина', 'Татьяна', 'генеральный директор ООО «Перегородки в офис»',
      '456 обращений в месяц', '20+', 'Менеджер маркетплейсов',
    ];
    expect(nameListLooksReal(junkRow)).toBe(false);
  });

  it('still trusts a real client list that carries a little noise', () => {
    expect(nameListLooksReal(['Сбербанк', 'Газпром', 'Лента', 'Магнит', 'Отрасли'])).toBe(true);
  });

  it('distrusts a job-board row dominated by cities, countries and roles', () => {
    const linkedinRow = [
      'Customer Service Representative', 'Дублин', 'Огайо', 'Соединенные Штаты Америки',
      'Customer Experience Associate', 'Нью-Йорк', 'Калифорния', 'Сан-Франциско',
      'Remote Customer Service Representative',
    ];
    expect(nameListLooksReal(linkedinRow)).toBe(false);
  });

  it('distrusts a row of product feature phrases', () => {
    const featureRow = [
      'Вся команда в одном месте', 'Встроенные видеоконференции',
      'График активности и скорость ответа', 'Рабочий чат с привычным функционалом',
      'Защита контента и безопасность данных', 'Разные роли внутри команды',
    ];
    expect(nameListLooksReal(featureRow)).toBe(false);
  });

  it('keeps a single plausible name', () => {
    expect(nameListLooksReal(['Газпром'])).toBe(true);
  });

  it('drops a single junk entry', () => {
    expect(nameListLooksReal(['ayvervdk9wrpaqde6begp6jfmg'])).toBe(false);
  });

  it('treats an empty list as untrusted', () => {
    expect(nameListLooksReal([])).toBe(false);
  });
});
