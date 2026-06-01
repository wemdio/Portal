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

const JSON_LD_EMPLOYEES_RE = /"numberOfEmployees"\s*:\s*\{[^}]*"value"\s*:\s*"?(\d+)"?/;

const MAX_TEAM = 200;
// `[class*="team"] img[alt]` matches anything with "team" anywhere in a class
// name — testimonial blocks ("their-team-says"), navigation, footer widgets.
// Above this many matches we stop trusting the count and ask the LLM.
const DOM_TRUST_LIMIT = 80;

const TEAM_TEXT_RE = /(?:более\s+|свыше\s+|>?\s*)(\d+)\s*(?:\+\s*)?(?:сотрудник|специалист|человек|эксперт|профессионал|member|employee|people|expert)/i;
const TEAM_TEXT_RE2 = /(?:команда|штат|коллектив|team)\s+(?:из\s+|of\s+)?(?:более\s+|свыше\s+)?(\d+)/i;

function readTextClaim(html: string): number {
  // Lightweight body-text extraction — cheap enough to do without re-parsing.
  const text = html.replace(/<[^>]+>/g, ' ');
  const m = text.match(TEAM_TEXT_RE) ?? text.match(TEAM_TEXT_RE2);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return n > 0 && n <= MAX_TEAM ? n : 0;
}

export function extractTeamSize(html: string): number {
  if (!html) return 0;

  // Try JSON-LD first — most reliable when present.
  const jm = html.match(JSON_LD_EMPLOYEES_RE);
  if (jm) {
    const n = parseInt(jm[1], 10);
    if (n > 0 && n <= MAX_TEAM) return n;
  }

  const $ = cheerio.load(html);
  const strictCount = $(TEAM_MEMBER_SELECTOR).length;
  if (strictCount > 0) {
    // Trust the explicit team-member selectors directly — they are tight
    // enough that a high count usually reflects a real team page.
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

  const claim = readTextClaim(html);
  return claim > 0 ? claim : 0;
}
