import * as cheerio from 'cheerio';
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
  isPhotoFilename,
} from './nameQuality';

const JUNK_PATTERNS: RegExp[] = [
  /^logo$/i, /^image$/i, /^icon$/i, /^photo$/i, /^avatar$/i,
  /^\s*\d+\s*$/, /^img$/i, /^picture$/i, /^banner$/i,
  /^logo\s*\d*$/i, /^client\s*logo$/i, /^\s*$/,
  /\.(png|jpg|jpeg|svg|webp|gif)$/i,
  /^company\s+logo\s*\d*$/i,
  /^клиент\s*\d+$/i, /^client\s*\d+$/i,
  /^title$/i, /^background$/i, /^slider$/i, /^slide$/i, /^hero$/i,
  /^подробнее$/i, /^читать$/i, /^смотреть$/i, /^узнать$/i,
  /^награда$/i, /^award$/i,
  /^[0-9a-f]{6,}\s+\d/i, // CMS block/element IDs like "ced3ffbe 1 1"
  /^otziv\d*$/i,          // CMS image filenames like "otziv3"
  /^review\s*\d*$/i,      // alt="review1" artifacts
  /^shape\s+\d+$/i,       // Figma/design "shape 4"
  /^[a-z]{2,}\s+\d+[a-z]$/i, // "nutriciologiya sm@1x" style image names → caught by @
  // ─── Декоративные элементы Tilda/конструкторов, которые лезли в выгрузку
  //     04.06 у 44k базы ("arrow", "gallery grid 1 x", "1 2 1 x", "card img").
  //     См. промежуточные результаты.txt — это были alt-text слайдеров,
  //     декоративных фонов и иконок-стрелок, а не имена клиентов.
  /^arrow\s*\d*$/i, /^dot\s*\d*$/i, /^bullet\s*\d*$/i,
  /^chevron(?:[-_\s]*(?:left|right|up|down|next|prev))?\s*\d*$/i,
  /^gallery\s+(?:grid|item|slide|thumb)\s*\d*\s*x?$/i, // "gallery grid 1 x"
  /^grid\s*\d*\s*x?$/i,
  /^(?:\d+\s+){1,4}\d*\s*x$/i,                         // "1 2 1 x", "0 2 x", "1 9 x"
  /^(?:\d+[\s-]+){2,}\d+\s*$/,                         // numeric-only blob "1 2 1"
  /^card\s+img$/i, /^payment\s+\w+$/i,
  /^(?:visa|mastercard|master\s*card|maestro|mir|paypal|qiwi|webmoney|sber\s*pay|tinkoff\s*pay|apple\s*pay|google\s*pay)\s*\d*$/i,
  // Tilda CMS image filenames: "barinhaus1 thumb", "poselok na sokole thumb",
  // "milenium park9 scaled", "Боровой 1 1 scaled", "DSC 1 scaled" — alt-text
  // декоративных карточек / превью.
  /\s+(?:thumb|thumbnail|scaled|small|big|large|medium|preview|cover|min|max)\s*\d*$/i,
  /^DSC[\s_]*\d+\b/i,                                  // "DSC 1 scaled"
  /^IMG[\s_]*\d+\b/i,
  // CSS-классы фоновых элементов: "bg color 1", "main bg", "section bg"
  /^(?:bg|background)[\s-]+\w+/i, /^(?:main|section|hero|page)[\s-]+(?:bg|background)$/i,
  // Sentence-ish строки вроде "Соглашение компании «X»" — это заголовок
  // юридического раздела, а не клиент. Без полной семантики ловим по началу.
  /^(?:Соглашение|Политика|Договор|Оферта|Условия)\s+(?:компании|использования|оказания)/i,
];

const LOGO_PREFIX_RE = /^(?:лого(?:тип)?|logo)\s+/i;
const REVIEW_PREFIX_RE = /^(?:review|otziv\w*|отзыв(?:\s+от)?)\s+/i;
const DESCRIPTION_RE = /(?:клиент по|продвижен|кейс[аыов]*\s+с\s+описани|стратеги[яи]|результат|рекоменд|стать клиентом|видеоотзыв|мониторим|фильтруем|передаём|почему|юридическ|эффективнее|слайд|читать кейс|подробн|услуг[аи])/i;

function isJunk(s: string): boolean {
  if (!s || s.length > 80) return true;
  if (s.length < 2) return true;
  if (JUNK_PATTERNS.some((re) => re.test(s))) return true;
  if (DESCRIPTION_RE.test(s)) return true;
  if (/^https?:\/\//i.test(s)) return true;
  if (s.split(/\s+/).length > 8) return true;
  if (/@/.test(s)) return true;  // filename artifacts like "sm@1x"
  if (/%/.test(s)) return true;  // any percent: URL-encoded chars, "ppc%world"
  // CMS image hashes, design-tool exports, nav/CTA labels and marketing
  // service names are the dominant noise classes — reject them outright.
  if (isHashLike(s) || isDesignArtifact(s) || isMostlyHexTokens(s)) return true;
  if (isNavOrCtaText(s) || isServiceText(s)) return true;
  // Statistics, brief-form labels, testimonial author roles/names, blog/FAQ
  // titles and industry-segment words are all NOT client company names.
  if (isMetricText(s) || isFormLabel(s)) return true;
  if (isRoleTitle(s) || isSentenceLike(s)) return true;
  if (isIndustryOrSector(s) || isPersonName(s)) return true;
  if (isPlaceName(s) || isAddressLike(s)) return true;
  // CSS-class fragments ("hero img", "blue circle color"), generic UI words
  // ("services", "more", "subscribe") and category labels ("SaaS / IT") are
  // never client names.
  if (isUiFragment(s)) return true;
  // Photo/avatar filenames leaking from testimonial blocks: "mikh fresh2",
  // "kate fin", "aziz".
  if (isPhotoFilename(s)) return true;
  return false;
}

function cleanName(s: string): string {
  let cleaned = s.trim();
  // Remove case/client label prefixes
  const casePrefix = /^(?:кейс|case|case study|клиент|проект|project)\s*[:—\-–]\s*(.+)$/i;
  const m = cleaned.match(casePrefix);
  if (m && m[1].trim()) cleaned = m[1].trim();
  cleaned = cleaned.replace(LOGO_PREFIX_RE, '').trim();
  cleaned = cleaned.replace(REVIEW_PREFIX_RE, '').trim();
  // Strip leading CMS hash/hex-blob tokens so the real brand survives:
  // "ddec1ab1 verticali" → "verticali", "cfbaa2cdac8ff alfa money" → "alfa money".
  const parts = cleaned.split(/\s+/);
  while (parts.length > 1 && (/^[0-9a-f]{6,}$/i.test(parts[0]) || isHashLike(parts[0]))) {
    parts.shift();
  }
  cleaned = parts.join(' ');
  // Strip trailing CMS number suffixes: "friends 1", "bbdo n 1", "elama logo 1"
  cleaned = cleaned.replace(/\s+(?:logo\s+)?\d{1,2}$/, '').trim();
  // Strip trailing " n \d+" pattern (alt="brand n 1" from numbered logo walls)
  cleaned = cleaned.replace(/\s+[nN]\s+\d+$/, '').trim();
  return cleaned;
}

function nameFromSrc(src: string): string | null {
  if (!src) return null;
  const match = src.match(/([^/]+)\.\w{3,4}(?:\?.*)?$/);
  if (!match) return null;
  const name = match[1]
    .replace(/[-_]+/g, ' ')
    .replace(/\d{2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length < 2 || name.length > 40) return null;
  if (/^(?:logo|img|image|icon|pic|photo|banner|bg|placeholder|default|noimage)\s*\d*$/i.test(name)) return null;
  if (isHashLike(name)) return null;
  if (/logo/i.test(name)) return null; // "msslogo big" — logo image filenames
  return name;
}

// Explicit client/customer containers — safe to read both logos and text.
const STRICT_CLIENT_SELECTOR = [
  '[class*="client"]', '[class*="customer"]',
  '#clients', '#customers',
  // Русские альтернативы которые часто встречаются у b2b-сайтов и
  // которые мы раньше игнорировали (recall был 2.3%, см. промежуточные
  // результаты.txt от 04.06): «с нами работают», «доверяют», «среди
  // наших».
  '[class*="zakazchik"]', '[class*="zakazchiki"]', // транслит
  '[id*="clients"]', '[id*="customers"]',
  '[data-section*="client"]', '[data-section*="customer"]',
].join(', ');

// Generic logo walls (partners / trust badges / marquees). Text inside these
// is almost always nav or marketing noise, so we read images (logos) only.
const LOGO_WALL_SELECTOR = [
  '[class*="-logos"]', '[class*="_logos"]',
  '[class*="partner"]', '[class*="trust"]',
  '[class*="marquee"]',
  '[data-record-type="595"]', // Tilda logo gallery block (logos grid)
  '[data-record-type="296"]', // Tilda block-with-photo-grid (sometimes used for logos)
  '[data-record-type="471"]', // Tilda «партнёры/клиенты» template
  '#partners',
  // Расширяем по терминам, которые тоже обозначают logo walls на сайтах
  // российских b2b: «компании», «бренды», «их выбирают», «работаем с»,
  // «references» (en).
  '[class*="company-logo"]', '[class*="company_logo"]',
  '[class*="brand"]', '[class*="brands"]',
  '[class*="references"]', '[class*="reference-"]', '[class*="reference_"]',
  '[class*="our-companies"]', '[class*="our_companies"]', '[class*="companies"]',
  '[class*="who-we-work-with"]', '[class*="work-with"]',
  '[class*="t-clients"]',  // Tilda кастомный класс для секции клиентов
  '#brands', '#references', '#companies',
].join(', ');

const CASE_CARD_SELECTOR = [
  '[class*="case-card"]', '[class*="case-item"]', '[class*="case-study"]',
  '[class*="client-card"]', '[class*="client-item"]', '[class*="client-cell"]',
  '[class*="portfolio-item"]', '[class*="portfolio-card"]',
  '[class*="project-card"]', '[class*="project-item"]',
  '[class*="work-item"]', '[class*="work-card"]',
  '[class*="success-story"]',
  '[class*="b2b-case__logo"]',
  '[class*="isotope-item"]',
].join(', ');

// Slider/carousel containers
const SLIDER_SELECTOR = [
  '[class*="swiper"]', '[class*="slick"]',
  '[class*="carousel"]', '[class*="slider"]',
  '[class*="t-slds"]',
].join(', ');

const SECTION_HEADING_RE = new RegExp(
  [
    // Existing — оставлены как есть, переменные расширены ниже.
    String.raw`(?:наши\s+)?клиенты`,
    String.raw`нам\s+доверяют`,
    String.raw`(?:наши\s+)?партн[еёр]ры`,
    String.raw`они\s+(?:выбрали|доверяют|работают)`,
    String.raw`(?:our\s+)?clients`,
    String.raw`(?:our\s+)?customers`,
    String.raw`trusted\s+by`,
    String.raw`(?:our\s+)?partners`,
    String.raw`who\s+(?:we\s+)?work\s+with`,
    String.raw`работаем\s+с`,
    String.raw`с\s+нами\s+работают`,
    // ─── Расширения 04.06 на основе анализа промежуточные результаты.txt:
    // 97.7% сайтов имеют контейнер с клиентами под другим заголовком,
    // которого старый regex не ловил.
    String.raw`среди\s+наших\s+(?:клиентов|партн[ёе]ров)`,
    String.raw`нас\s+выбирают`,
    String.raw`нам\s+(?:доверяют|выбирают)`,
    String.raw`они\s+(?:уже\s+)?(?:с\s+нами|нам\s+доверяют)`,
    String.raw`их\s+выбирают`,
    String.raw`мы\s+(?:работаем|делали)\s+для`,
    String.raw`компании(?:,)?\s+которые\s+нам\s+довер`,
    String.raw`(?:наши\s+)?(?:компании|бренды|заказчики|кейсы)`,
    String.raw`references`,
    String.raw`brands\s+(?:we|that)\s+work\s+with`,
    String.raw`featured\s+(?:in|customers)`,
    String.raw`among\s+our\s+(?:clients|customers|partners)`,
    String.raw`используют\s+(?:наш|нас|нашу)`,
    String.raw`выбирают\s+нас`,
    String.raw`довер(?:яют|ились)\s+нам`,
    String.raw`для\s+кого\s+мы\s+работаем`,
  ].join('|'),
  'i',
);

const CAP = 30;

type $Type = cheerio.CheerioAPI;
type AddFn = (s: string) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CheerioSelection = cheerio.Cheerio<any>;

function extractFromImages($: $Type, container: CheerioSelection, add: AddFn): void {
  container.find('img').each((_, img) => {
    const alt = ($(img).attr('alt') ?? '').trim();
    if (alt) {
      add(alt);
    } else {
      const src = $(img).attr('src') ?? $(img).attr('data-original') ?? $(img).attr('data-src') ?? '';
      const name = nameFromSrc(src);
      if (name) add(name);
    }
  });
}

function extractFromText($: $Type, container: CheerioSelection, add: AddFn): void {
  container.find('span, li, a, h3, h4, h5, strong, b, [class*="name"]').each((_, el) => {
    const t = $(el).text().trim();
    if (t && t.length >= 2 && t.length <= 60 && !SECTION_HEADING_RE.test(t)) {
      add(t);
    }
  });
}

function findSectionFromHeading($: $Type, heading: CheerioSelection): CheerioSelection {
  let section = heading.parent();
  // Traverse up: heading is often inside a wrapper, the actual content is in sibling/parent container
  for (let i = 0; i < 3; i++) {
    if (section.find('img').length >= 3 || section.find('li, [class*="item"]').length >= 3) break;
    const up = section.parent();
    if (!up.length || up.is('body') || up.is('html')) break;
    section = up;
  }
  return section;
}

export function extractCustomers(html: string): string[] {
  if (!html) return [];
  const $ = cheerio.load(html);
  $('script, style, noscript, template').remove();
  const seen = new Set<string>();
  const result: string[] = [];

  function add(s: string): void {
    if (result.length >= CAP) return;
    const cleaned = cleanName(s);
    if (isJunk(cleaned)) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(cleaned);
  }

  // Strategy 1a: explicit client containers — logos + text labels.
  $(STRICT_CLIENT_SELECTOR).each((_, container) => {
    if (result.length >= CAP) return false;
    extractFromImages($, $(container), add);
    extractFromText($, $(container), add);
  });

  // Strategy 1b: generic logo walls — logos only (text here is nav noise).
  if (result.length < CAP) {
    $(LOGO_WALL_SELECTOR).each((_, container) => {
      if (result.length >= CAP) return false;
      extractFromImages($, $(container), add);
    });
  }

  // Strategy 2: case/project card headings + logos inside cards
  if (result.length < CAP) {
    $(CASE_CARD_SELECTOR).each((_, container) => {
      if (result.length >= CAP) return false;
      const heading = $(container).find('h2, h3, h4').first().text().trim();
      if (heading && !SECTION_HEADING_RE.test(heading)) add(heading);
      extractFromImages($, $(container), add);
    });
  }

  // Strategy 3: slider/carousel containers (Swiper, Slick, Tilda)
  if (result.length < CAP) {
    $(SLIDER_SELECTOR).each((_, slider) => {
      if (result.length >= CAP) return false;
      const $slider = $(slider);
      const parentText = $slider.parent().text().toLowerCase();
      if (!SECTION_HEADING_RE.test(parentText) && !$slider.closest('[class*="client"], [class*="partner"], [class*="trust"], #clients, #partners').length) return;
      extractFromImages($, $slider, add);
      extractFromText($, $slider, add);
    });
  }

  // Strategy 4: Tilda review/testimonial blocks — author names
  if (result.length < CAP) {
    $('[class*="t958__author-name"], [class*="review__author"], [class*="testimonial__name"]').each((_, el) => {
      if (result.length >= CAP) return false;
      add($(el).text().trim());
    });
  }

  // Strategy 5: find sections by heading text, traverse UP to find real container
  if (result.length < CAP) {
    $('h1, h2, h3, h4, [class*="title"], [class*="heading"]').each((_, heading) => {
      if (result.length >= CAP) return false;
      const text = $(heading).text().trim();
      if (!SECTION_HEADING_RE.test(text)) return;

      const section = findSectionFromHeading($, $(heading));
      extractFromImages($, section, add);
      extractFromText($, section, add);
    });
  }

  return result.slice(0, CAP);
}
