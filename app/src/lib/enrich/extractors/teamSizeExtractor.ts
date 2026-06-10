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

// Bumped from 200 → 5000 after the 09.06 промка feedback: МОСЛИФТ /
// КАСКАД-ЭНЕРГО / ЭНКОМ КСМ have 300-1000 рабочих each, and the old cap
// silently dropped every claim above 200 to a returned 0. 5000 still
// catches malformed numbers ("в нашей команде 99999 человек") without
// chopping legit industrial teams.
const MAX_TEAM = 5000;
// `[class*="team"] img[alt]` matches anything with "team" anywhere in a class
// name — testimonial blocks ("their-team-says"), navigation, footer widgets.
// Above this many matches we stop trusting the count and ask the LLM.
const DOM_TRUST_LIMIT = 80;

// Headline phrasings — pick the FIRST plausible number, since a page usually
// announces its team size in just one place (hero / footer / about).
// NB: JS `\w` is ASCII-only and `\b` doesn't fire between Cyrillic and EOS.
// All RU patterns use [а-яё]* for declension endings instead of \w+, and
// avoid trailing \b — the leading anchors (digit + space + stem) are already
// specific enough to prevent false positives.
const TEXT_PATTERNS: RegExp[] = [
  // "более 50 сотрудников", "свыше 30 специалистов" — расширил `сотрудник` на
  // blue-collar профессии (рабочий/монтажник/слесарь и т.д.) после фидбэка
  // 09.06: МОСЛИФТ/КАСКАД-ЭНЕРГО team_size=0% потому что они пишут «300
  // рабочих» а не «300 сотрудников».
  /(?:более|свыше|более\s+чем|свыше\s+чем)\s+(\d+)\s*(?:\+\s*)?(?:сотрудник|работник|специалист|человек|эксперт|профессионал|программист|разработчик|инженер|консультант|монтажник|слесар|механик|электрик|сварщик|машинист|рабочи|строител|техник|оператор|member|employee|people|expert|worker)/i,
  // "50+ сотрудников", "30 специалистов"
  /(\d+)\s*\+?\s*(?:сотрудник|работник|специалист|человек|эксперт|профессионал|программист|разработчик|инженер|консультант|монтажник|слесар|механик|электрик|сварщик|машинист|рабочи|строител|техник|оператор|member|employee|people|expert|worker)/i,
  // "команда из 25 человек", "team of 40"
  /(?:команда|штат[а-яё]*|коллектив|team)\s+(?:из\s+|of\s+)?(?:более\s+|свыше\s+|over\s+)?(\d+)/i,
  // "в нашей команде 12 человек"
  /в\s+(?:нашей\s+)?команде\s+(?:уже\s+)?(?:более\s+)?(\d+)/i,
  // "наша команда — 80 человек"
  /наша\s+команда\s*[—:\-–]\s*(?:более\s+)?(\d+)/i,
  // "штатная численность: N" / "штат компании: N" / "штат составляет N".
  // [а-яё]* covers «штатная/штатной» and «численности/численностью» tails.
  /штатн[а-яё]*\s+численност[а-яё]*\s*[—:\-–]?\s*(\d+)/i,
  /штат[а-яё]*\s+компании\s*[—:\-–]?\s*(\d+)/i,
  /штат[а-яё]*\s+(?:составляет|насчитывает|превышает)\s+(?:более\s+|свыше\s+)?(\d+)/i,
  // "численность работников: N" / "численность сотрудников 200" / "численности
  // персонала: 250" — three declined forms covered by [а-яё]*.
  /численност[а-яё]*\s+(?:работник|сотрудник|персонал)[а-яё]*\s*[—:\-–]?\s*(?:более\s+|свыше\s+)?(\d+)/i,
  // "коллектив насчитывает N", "коллектив компании объединяет N"
  /коллектив\s+(?:компании\s+)?(?:насчитывает|включает|объединяет|объединил|состоит\s+из)\s+(?:более\s+|свыше\s+)?(\d+)/i,
  // "около N специалистов", "около N сотрудников", "около N человек"
  /около\s+(\d+)\s+(?:сотрудник|специалист|человек|работник)/i,
  // "более N человек работают/трудятся в компании"
  /(?:более|свыше)\s+(\d+)\s+(?:человек|сотрудник[а-яё]*|работник[а-яё]*)\s+(?:работа|труд)/i,
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
