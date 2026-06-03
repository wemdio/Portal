import * as cheerio from 'cheerio';

const TEAM_MEMBER_SELECTOR = [
  '[class*="member-card"]', '[class*="member-item"]',
  '[class*="team-member"]', '[class*="team-card"]', '[class*="team-item"]',
  '[class*="employee"]',
  '[class*="staff-card"]', '[class*="staff-item"]', '[class*="staff-member"]',
  '[class*="person-card"]', '[class*="person-item"]',
  '[class*="our-team"] li',
].join(', ');

const TEAM_PHOTO_FALLBACK_SELECTOR = '[class*="team"] img[alt]';

// schema.org `numberOfEmployees` shows up in two shapes:
//   { "numberOfEmployees": { "@type": "QuantitativeValue", "value": "42" } }
//   { "numberOfEmployees": 42 }
const JSON_LD_EMPLOYEES_NESTED_RE = /"numberOfEmployees"\s*:\s*\{[^}]*"value"\s*:\s*"?(\d+)"?/;
const JSON_LD_EMPLOYEES_FLAT_RE = /"numberOfEmployees"\s*:\s*"?(\d+)"?/;

// Microdata: `<span itemprop="numberOfEmployees">42</span>` or
// `<meta itemprop="numberOfEmployees" content="42">`.
const MICRODATA_EMPLOYEES_RE =
  /itemprop\s*=\s*["']numberOfEmployees["'][^>]*?(?:content|value)\s*=\s*["'](\d+)/i;
const MICRODATA_EMPLOYEES_TEXT_RE =
  /itemprop\s*=\s*["']numberOfEmployees["'][^>]*>\s*(\d+)/i;

const MAX_TEAM = 200;
// `[class*="team"] img[alt]` matches anything with "team" anywhere in a class
// name — testimonial blocks ("their-team-says"), navigation, footer widgets.
// Above this many matches we stop trusting the count and ask the LLM.
const DOM_TRUST_LIMIT = 80;

// Headline phrasings — pick the FIRST plausible number, since a page usually
// announces its team size in just one place (hero / footer / about).
const TEXT_PATTERNS: RegExp[] = [
  // "более 50 сотрудников", "свыше 30 специалистов"
  /(?:более|свыше|более\s+чем|свыше\s+чем)\s+(\d+)\s*(?:\+\s*)?(?:сотрудник|специалист|человек|эксперт|профессионал|программист|разработчик|инженер|консультант|member|employee|people|expert)/i,
  // "50+ сотрудников", "30 специалистов"
  /(\d+)\s*\+?\s*(?:сотрудник|специалист|человек|эксперт|профессионал|программист|разработчик|инженер|консультант|member|employee|people|expert)\b/i,
  // "команда из 25 человек", "team of 40"
  /(?:команда|штат|коллектив|team)\s+(?:из\s+|of\s+)?(?:более\s+|свыше\s+|over\s+)?(\d+)/i,
  // "в нашей команде 12 человек"
  /в\s+(?:нашей\s+)?команде\s+(?:уже\s+)?(?:более\s+)?(\d+)/i,
  // "наша команда — 80 человек"
  /наша\s+команда\s*[—:\-–]\s*(?:более\s+)?(\d+)/i,
  // "штатная численность: N"
  /штатн\w+\s+численност\w+\s*[—:\-–]\s*(\d+)/i,
  // "We are a team of 15"
  /we\s+are\s+a\s+team\s+of\s+(\d+)/i,
  // "company size: 10-50" — pick the lower bound (conservative)
  /(?:company\s+size|размер\s+компании|размер\s+штата)\s*[—:\-–]\s*(\d+)\s*[—\-–]\s*\d+/i,
];

function readTextClaim(html: string): number {
  // Lightweight body-text extraction — cheap enough to do without re-parsing.
  const text = html.replace(/<[^>]+>/g, ' ');
  for (const re of TEXT_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 0 && n <= MAX_TEAM) return n;
    }
  }
  return 0;
}

function readJsonLdOrMicrodata(html: string): number {
  const m =
    html.match(JSON_LD_EMPLOYEES_NESTED_RE)
    ?? html.match(JSON_LD_EMPLOYEES_FLAT_RE)
    ?? html.match(MICRODATA_EMPLOYEES_RE)
    ?? html.match(MICRODATA_EMPLOYEES_TEXT_RE);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return n > 0 && n <= MAX_TEAM ? n : 0;
}

export function extractTeamSize(html: string): number {
  if (!html) return 0;

  // 1. Structured data first — most reliable.
  const structured = readJsonLdOrMicrodata(html);
  if (structured > 0) return structured;

  const $ = cheerio.load(html);
  const strictCount = $(TEAM_MEMBER_SELECTOR).length;
  if (strictCount > 0) {
    // Trust the explicit team-member selectors directly — they are tight
    // enough that a small/medium count usually reflects a real team page.
    if (strictCount <= DOM_TRUST_LIMIT) return strictCount;
    // Above the trust limit, require a text claim to confirm.
    const claim = readTextClaim(html);
    if (claim > 0) return Math.min(claim, MAX_TEAM);
    return 0;
  }

  const looseCount = $(TEAM_PHOTO_FALLBACK_SELECTOR).length;
  if (looseCount > 0) {
    // Loose selector ("[class*=team] img[alt]") is much noisier — only trust
    // small counts (a real "наша команда" block) or counts corroborated by text.
    if (looseCount <= 30) return looseCount;
    const claim = readTextClaim(html);
    if (claim > 0) return Math.min(claim, MAX_TEAM);
    return 0;
  }

  // Text-only signal — useful when there's no team page at all but the
  // homepage / about page brags "в нашей команде 25 человек".
  const claim = readTextClaim(html);
  return claim > 0 ? claim : 0;
}
