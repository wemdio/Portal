import * as cheerio from 'cheerio';

const TEAM_MEMBER_SELECTOR = [
  '[class~="member-card"]',
  '[class~="team-member"]',
  '[class~="employee"]',
  '[class~="staff"]',
  '[class~="member"]',
].join(', ');

const TEAM_PHOTO_FALLBACK_SELECTOR = '[class*="team"] img[alt]';

const MAX_TEAM = 200;

export function extractTeamSize(html: string): number {
  if (!html) return 0;
  const $ = cheerio.load(html);
  let count = $(TEAM_MEMBER_SELECTOR).length;

  if (count === 0) {
    count = $(TEAM_PHOTO_FALLBACK_SELECTOR).length;
  }

  return Math.min(count, MAX_TEAM);
}
