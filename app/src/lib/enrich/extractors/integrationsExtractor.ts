import * as cheerio from 'cheerio';
import { isHashLike, isDesignArtifact, isNavOrCtaText, isServiceText } from './nameQuality';

const JUNK_RE: RegExp[] = [
  /^logo$/i, /^image$/i, /^icon$/i, /^photo$/i, /^avatar$/i,
  /^client logo$/i, /^logo\s*\d*$/i, /^\s*\d+\s*$/, /^$/,
  /^img$/i, /^picture$/i, /^banner$/i,
  /^title$/i, /^background$/i, /^slider$/i, /^slide$/i,
  /^подробнее$/i, /^партнерство$/i, /^преимущества$/i,
  /^подписаться/i, /^узнать/i, /^читать/i, /^смотреть/i,
  /^subscribe\s*\d*$/i, // "subscribe 1"
  /^награда$/i, /^award$/i,
  /^\d+(\s+\d+)+$/,     // "1 1 1" — multiple space-separated numbers
  /^zagruz/i,           // "zagruzhennoe" — transliterated loading image names
  /\slogo\s/i,          // embedded " logo " word — describes an image, not a name
];

const URL_RE = /^https?:\/\//i;
const LOGO_PREFIX_RE = /^(?:лого(?:тип)?|logo)\s+/i;
const DESCRIPTION_RE = /(?:рейтинг|публикаци|конференци|тренажёр|тренажер|платформа\s+для|урок[иов]|домашк|клуб[аыов]|беседы|маркетинг\s*360|подбор\s+блогер|комплексн|influence|пиар\s+и\s+|информация\s+о|задачи\s+конф|цель\s+конф|рассылк|продвижен|стратеги|результат)/i;

function isJunk(s: string): boolean {
  if (!s || s.length > 50) return true;
  if (s.length < 2) return true;
  if (URL_RE.test(s)) return true;
  if (JUNK_RE.some((re) => re.test(s.trim()))) return true;
  if (DESCRIPTION_RE.test(s)) return true;
  if (s.split(/\s+/).length > 5) return true;
  if (/@/.test(s)) return true;               // filename artifacts like "sm@1x"
  if (/%/.test(s)) return true;              // any percent: "ppc%world", "%D0%9F…"
  // CMS image hashes, design-tool exports, nav/CTA labels and marketing
  // service names are the dominant noise classes — reject them outright.
  if (isHashLike(s) || isDesignArtifact(s)) return true;
  if (isNavOrCtaText(s) || isServiceText(s)) return true;
  return false;
}

function cleanName(s: string): string {
  let cleaned = s.replace(LOGO_PREFIX_RE, '').trim();
  // Strip leading Tilda/CMS hex hash: "fd4dbb8dde interfax" → "interfax"
  cleaned = cleaned.replace(/^[0-9a-f]{6,}\s+/i, '').trim();
  // Strip trailing Tilda element suffix: "ramu e" → "ramu"
  cleaned = cleaned.replace(/\s+[eE]$/, '').trim();
  // Strip trailing logo descriptor + optional number: "arir logo e" → "arir", "big logo 1" → "big"
  cleaned = cleaned.replace(/\s+logo\s*\d*$/i, '').trim();
  // Strip trailing CMS number suffixes: "subscribe 1", "brand n 1"
  cleaned = cleaned.replace(/\s+(?:logo\s+)?\d{1,2}$/, '').trim();
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
  if (/^(?:logo|img|image|icon|pic|photo|banner|bg|placeholder|default|noimage|pr)\s*\d*$/i.test(name)) return null;
  if (isHashLike(name)) return null;
  if (/logo/i.test(name)) return null; // "msslogo big", "biglogo" — logo image filenames
  return name;
}

// Explicit integration containers — safe to read both logos and text.
const STRICT_INTEGRATION_SELECTOR = [
  '[class*="integration"]', '[class*="connector"]',
  '#integrations', '#connectors',
].join(', ');

// Looser logo/stack containers. Text inside is unreliable (toolbars, menus,
// generic layout classes), so we read images (logos) only.
const LOGO_WALL_SELECTOR = [
  '[class*="app-card"]', '[class*="ecosystem"]',
  '[class*="marketplace"]', '[class*="compatible"]',
  '[class*="stack"]', '[class*="framework"]',
  '[class*="technolog"]', '[class*="partner"]',
  '#tools', '#stack', '#technologies', '#partners',
].join(', ');

const SECTION_HEADING_RE = /интеграци|подключени|совместимост|экосистем|integrations?|connectors?|apps?\s+(?:we|&)|works?\s+with|compatible|инструмент[аыов]|технологи[яи]|(?:наш|наши|we\s+use)\s+(?:стек|stack|tools)|стек\s+технологий|tech\s+stack|(?:мы\s+)?работаем\s+с/i;

const SLIDER_SELECTOR = [
  '[class*="swiper"]', '[class*="slick"]',
  '[class*="carousel"]', '[class*="slider"]',
  '[class*="marquee"]', '[class*="t-slds"]',
].join(', ');

const MAX_INTEGRATIONS = 20;

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
  container.find('li, a, h3, h4, h5, span, strong, b, [class*="name"]').each((_, el) => {
    const t = $(el).text().trim();
    if (t && t.length >= 2 && t.length <= 40 && !SECTION_HEADING_RE.test(t)) {
      add(t);
    }
  });
}

function findSectionFromHeading($: $Type, heading: CheerioSelection): CheerioSelection {
  let section = heading.parent();
  for (let i = 0; i < 3; i++) {
    if (section.find('img').length >= 3 || section.find('li, [class*="item"]').length >= 3) break;
    const up = section.parent();
    if (!up.length || up.is('body') || up.is('html')) break;
    section = up;
  }
  return section;
}

export function extractIntegrations(html: string): string[] {
  if (!html) return [];
  const $ = cheerio.load(html);
  $('script, style, noscript, template').remove();
  const seen = new Set<string>();
  const result: string[] = [];

  function add(raw: string): void {
    if (result.length >= MAX_INTEGRATIONS) return;
    const cleaned = cleanName(raw);
    if (isJunk(cleaned)) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(cleaned);
  }

  // Strategy 1a: explicit integration containers — logos + text labels.
  $(STRICT_INTEGRATION_SELECTOR).each((_, container) => {
    if (result.length >= MAX_INTEGRATIONS) return false;
    extractFromImages($, $(container), add);
    extractFromText($, $(container), add);
  });

  // Strategy 1b: looser logo/stack containers — logos only.
  if (result.length < MAX_INTEGRATIONS) {
    $(LOGO_WALL_SELECTOR).each((_, container) => {
      if (result.length >= MAX_INTEGRATIONS) return false;
      extractFromImages($, $(container), add);
    });
  }

  // Strategy 2: slider/carousel in integration-like context — logos only.
  if (result.length < MAX_INTEGRATIONS) {
    $(SLIDER_SELECTOR).each((_, slider) => {
      if (result.length >= MAX_INTEGRATIONS) return false;
      const $slider = $(slider);
      const parentText = $slider.parent().text().toLowerCase();
      if (!SECTION_HEADING_RE.test(parentText) && !$slider.closest('[class*="integration"], [class*="partner"], [class*="stack"], #integrations').length) return;
      extractFromImages($, $slider, add);
    });
  }

  // Strategy 3: find sections by heading text — logos only (text in an
  // arbitrary heading-matched section is too noisy to trust).
  if (result.length < MAX_INTEGRATIONS) {
    $('h1, h2, h3, h4, [class*="title"], [class*="heading"]').each((_, heading) => {
      if (result.length >= MAX_INTEGRATIONS) return false;
      const text = $(heading).text().trim();
      if (!SECTION_HEADING_RE.test(text)) return;

      const section = findSectionFromHeading($, $(heading));
      extractFromImages($, section, add);
    });
  }

  return result.slice(0, MAX_INTEGRATIONS);
}
