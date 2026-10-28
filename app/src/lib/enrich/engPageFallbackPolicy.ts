import * as cheerio from 'cheerio';

function readable(html: string): { text: string; emails: Set<string> } {
  const $ = cheerio.load(html);
  const mailto = $('a[href^="mailto:"]').map((_, el) => $(el).attr('href')?.slice(7).split('?')[0] ?? '').get().join(' ');
  $('script, style, noscript, svg, nav, header, footer').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return { text, emails: new Set(`${text} ${mailto}`.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi) ?? []) };
}

/** Do not replace useful original text/emails with an emptier rendered shell. */
export function isEngHtmlImprovement(original: string, candidate: string): boolean {
  const before = readable(original); const after = readable(candidate);
  return after.text.length > before.text.length || [...after.emails].some(email => !before.emails.has(email));
}

/** Refusals are terminal: rendering must never turn a challenge into company evidence. */
export function isEngHtmlBlocked(html: string): boolean {
  const $ = cheerio.load(html);
  const title = $('title').text();
  $('script, style, noscript').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 8000);
  return /(?:just a moment|attention required|access denied|request (?:was )?blocked|security check|captcha|verify (?:that )?you are human|checking your browser|unusual traffic|enable javascript and cookies to continue)/i.test(`${title} ${text}`)
    || /(?:\/cdn-cgi\/challenge-platform\/|cf-chl-|id=["']challenge-form|id=["']px-captcha|class=["'][^"']*g-recaptcha)/i.test(html)
    || /(?:sign in|log in|authentication required)/i.test(title) && $('input[type="password"]').length > 0;
}

/** Only a small empty document or JavaScript shell merits a second reader. */
export function isEngEmptyHtml(html: string): boolean {
  if (Buffer.byteLength(html, 'utf8') > 3 * 1024 * 1024 || isEngHtmlBlocked(html)) return false;
  const $ = cheerio.load(html);
  const hasScripts = $('script[src], script[type="module"], #__next, #root, #app').length > 0;
  $('script, style, noscript, svg, nav, header, footer').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return text.length < 30 || (hasScripts && text.length < 300);
}

export function isEngFallbackCandidate(input: { status?: number; html: string | null }): boolean {
  return input.status !== undefined && input.status >= 200 && input.status < 300
    && typeof input.html === 'string' && isEngEmptyHtml(input.html);
}
