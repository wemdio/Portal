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

const TEAM_TEXT_RE = /(?:более\s+|свыше\s+|>?\s*)(\d+)\s*(?:\+\s*)?(?:сотрудник|специалист|человек|эксперт|профессионал|member|employee|people|expert)/i;
const TEAM_TEXT_RE2 = /(?:команда|штат|коллектив|team)\s+(?:из\s+|of\s+)?(?:более\s+|свыше\s+)?(\d+)/i;

export function extractTeamSize(html: string): number {
  if (!html) return 0;

  // Try JSON-LD first.
  const jm = html.match(JSON_LD_EMPLOYEES_RE);
  if (jm) {
    const n = parseInt(jm[1], 10);
    if (n > 0 && n <= MAX_TEAM) return n;
  }

  const $ = cheerio.load(html);
  let count = $(TEAM_MEMBER_SELECTOR).length;

  if (count === 0) {
    count = $(TEAM_PHOTO_FALLBACK_SELECTOR).length;
  }

  if (count === 0) {
    const text = $('body').text();
    const m = text.match(TEAM_TEXT_RE) ?? text.match(TEAM_TEXT_RE2);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 0 && n <= MAX_TEAM) count = n;
    }
  }

  return Math.min(count, MAX_TEAM);
}
