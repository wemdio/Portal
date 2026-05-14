import * as cheerio from 'cheerio';

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
];

const LOGO_PREFIX_RE = /^(?:лого(?:тип)?|logo)\s+/i;
const DESCRIPTION_RE = /(?:клиент по|продвижен|кейс[аыов]*\s+с\s+описани|стратеги[яи]|результат|рекоменд|стать клиентом|видеоотзыв|мониторим|фильтруем|передаём|почему|юридическ|эффективнее|слайд|читать кейс|подробн|услуг[аи])/i;

function isJunk(s: string): boolean {
  if (!s || s.length > 80) return true;
  if (s.length < 2) return true;
  if (JUNK_PATTERNS.some((re) => re.test(s))) return true;
  if (DESCRIPTION_RE.test(s)) return true;
  if (/^https?:\/\//i.test(s)) return true;
  if (s.split(/\s+/).length > 8) return true;
  return false;
}

function cleanName(s: string): string {
  let cleaned = s.trim();
  const casePrefix = /^(?:кейс|case|case study|клиент|проект|project)\s*[:—\-–]\s*(.+)$/i;
  const m = cleaned.match(casePrefix);
  if (m && m[1].trim()) cleaned = m[1].trim();
  cleaned = cleaned.replace(LOGO_PREFIX_RE, '').trim();
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
  return name;
}

// Containers that typically hold client/partner logos
const LOGO_CONTAINER_SELECTOR = [
  '[class*="client"]', '[class*="customer"]',
  '[class*="-logos"]', '[class*="_logos"]',
  '[class*="partner"]', '[class*="trust"]',
  '[class*="brand"]',
  '[class*="marquee"]',
  // Tilda patterns
  '[data-record-type="595"]',
  // Section IDs
  '#clients', '#partners', '#customers',
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

const SECTION_HEADING_RE = /(?:наши\s+)?клиенты|нам\s+доверяют|(?:наши\s+)?партнёры|(?:наши\s+)?партнеры|они\s+(?:выбрали|доверяют|работают)|(?:our\s+)?clients|(?:our\s+)?customers|trusted\s+by|(?:our\s+)?partners|who\s+(?:we\s+)?work\s+with|работаем\s+с|с\s+нами\s+работают/i;

const CAP = 30;

type $Type = cheerio.CheerioAPI;
type AddFn = (s: string) => void;

function extractFromImages($: $Type, container: cheerio.Cheerio<cheerio.AnyNode>, add: AddFn): void {
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

function extractFromText($: $Type, container: cheerio.Cheerio<cheerio.AnyNode>, add: AddFn): void {
  container.find('span, li, a, h3, h4, h5, strong, b, [class*="name"]').each((_, el) => {
    const t = $(el).text().trim();
    if (t && t.length >= 2 && t.length <= 60 && !SECTION_HEADING_RE.test(t)) {
      add(t);
    }
  });
}

function findSectionFromHeading($: $Type, heading: cheerio.Cheerio<cheerio.AnyNode>): cheerio.Cheerio<cheerio.AnyNode> {
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

  // Strategy 1: logo containers by class/id
  $(LOGO_CONTAINER_SELECTOR).each((_, container) => {
    if (result.length >= CAP) return false;
    extractFromImages($, $(container), add);
    extractFromText($, $(container), add);
  });

  // Strategy 2: case/project card headings + logos inside cards
  if (result.length < CAP) {
    $(CASE_CARD_SELECTOR).each((_, container) => {
      if (result.length >= CAP) return false;
      const heading = $(container).find('h2, h3, h4').first().text().trim();
      if (heading) add(heading);
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
