import { loadBuffer } from 'cheerio';

export interface VeEvidencePage {
  text: string;
  url: string;
  links: Array<{ url: string; text: string }>;
  inns: string[];
  ownerInns?: string[];
}

const MAX_TEXT_CHARS = 6_000;
const EMAIL = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const STOP_WORDS = new Set('для или при это как что все без под над его она они где and the for with from that this into'.split(' '));

function cleanText(raw: string): string {
  return raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(EMAIL, '[email]').replace(/\s+/g, ' ').trim();
}

function focusTerms(focus: string): string[] {
  // Prefixes tolerate common inflections without introducing industry-specific
  // synonyms. They rank excerpts only; they do not establish relevance.
  return [...new Set((focus.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])
    .filter((term) => !STOP_WORDS.has(term))
    .map((term) => /^[а-яё]+$/u.test(term) && term.length > 6 ? term.slice(0, 6) : term))].slice(0, 32);
}

function matchTerms(text: string, terms: string[]): number[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.map((term) => Math.min(3, words.filter((word) => word.startsWith(term)).length));
}

/** Keep the page introduction and the strongest contextual passages anywhere
 * in the page. Missing focus terms never imply that an activity is absent.
 */
export function selectVeEvidenceText(raw: string, focus = '', maxChars = MAX_TEXT_CHARS): string {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.min(MAX_TEXT_CHARS, Math.floor(maxChars))) : MAX_TEXT_CHARS;
  const text = cleanText(raw);
  if (!limit || text.length < 60 || (text.match(/\p{L}/gu)?.length ?? 0) < 30) return '';
  if (/Страница доступна, но требует JavaScript или блокирует парсер/i.test(text)) return '';
  if (text.length < 1_200 && /access denied|just a moment|checking your browser|verify you are human|проверка браузера|подтвердите, что вы человек|доступ запрещ[её]н|сайт (?:временно )?недоступен|сайт на реконструкции|страница не найдена|404 not found/i.test(text.slice(0, 400))) return '';
  if (text.length <= limit) return text;
  const terms = focusTerms(focus);
  if (!terms.length) return text.slice(0, limit);

  const windows: Array<{ start: number; end: number; score: number }> = [];
  // Overlap retains qualifiers/negations when a sentence straddles a window.
  const windowSize = Math.max(1, Math.min(1_000, Math.floor(limit * 0.65)));
  for (let start = 0; start < text.length; start += Math.max(1, Math.floor(windowSize * 0.65))) {
    const end = Math.min(text.length, start + windowSize);
    const counts = matchTerms(text.slice(start, end), terms);
    const score = counts.filter(Boolean).length * 100 + counts.reduce((sum, count) => sum + count, 0);
    if (score) windows.push({ start, end, score });
  }
  if (!windows.length) return text.slice(0, limit);

  const ranges = [{ start: 0, end: Math.min(1_100, Math.floor(limit / 3)) }];
  const joinedLength = (items: typeof ranges) => items.reduce((sum, item) => sum + item.end - item.start, 0) + (items.length - 1) * 5;
  const merge = (items: typeof ranges) => items.sort((a, b) => a.start - b.start).reduce<typeof ranges>((result, item) => {
    const last = result[result.length - 1];
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else result.push({ ...item });
    return result;
  }, []);
  for (const window of windows.sort((a, b) => b.score - a.score || a.start - b.start)) {
    const candidate = merge([...ranges.map((range) => ({ ...range })), window]);
    if (joinedLength(candidate) > limit) continue;
    ranges.splice(0, ranges.length, ...candidate);
  }
  // Keep source order; ellipses make omitted intervals explicit.
  return ranges.map(({ start, end }) => text.slice(start, end)).join(' […] ').slice(0, limit);
}

function extractInns(text: string): string[] {
  const inns = new Set<string>();
  // Read all explicitly labelled values, including digits split by markup or
  // whitespace. Never infer a legal identity from an unlabelled number.
  const pattern = /(?:^|[^\p{L}\p{N}])(?:ИНН|INN)(?:\s*\/\s*КПП)?\s*[:：=№–—-]?\s*(\d(?:[\s\u200b]*\d){9,11})(?![\s\u200b]*\d)/giu;
  for (const match of text.matchAll(pattern)) {
    const value = match[1].replace(/\D/g, '');
    if (value.length === 10 || value.length === 12) inns.add(value);
  }
  return [...inns];
}

function isLegalPage(url: string): boolean {
  try {
    const path = decodeURIComponent(new URL(url).pathname);
    return /(?:^|\/)(?:contacts?|kontakty|контакты|rekvizit[yi]?|requisites?|реквизиты|oferta|оферта|privacy(?:-policy)?|policy|legal|politika(?:-konfidencialnosti)?|политика(?:-конфиденциальности)?)(?:\.(?:html?|php))?\/?$/iu.test(path);
  } catch { return false; }
}

/** Pure parser. Fetching, redirects, public-address checks and identity
 * acceptance remain the caller's responsibility.
 */
export function parseVeEvidencePage(body: Buffer, url: string, contentType: string, focus = ''): VeEvidencePage {
  const charset = contentType.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1];
  if (/^text\/plain\b/i.test(contentType)) {
    let raw: string;
    try { raw = new TextDecoder(charset ?? 'utf-8').decode(body); }
    catch { raw = body.toString('utf8'); }
    const inns = extractInns(raw);
    return { text: selectVeEvidenceText(raw, focus), url, links: [], inns, ownerInns: isLegalPage(url) ? inns : [] };
  }

  const $ = loadBuffer(body, { encoding: { transportLayerEncodingLabel: charset, defaultEncoding: 'utf-8' } });
  const title = $('title').text();
  const description = $('meta[name="description"], meta[property="og:description"]').map((_i, element) => $(element).attr('content') ?? '').get().join(' ');
  $('script, style, noscript, svg, iframe, form, template, [hidden], [aria-hidden="true"]').remove();
  // Separators preserve words/INN labels that HTML tags otherwise concatenate.
  $('br').replaceWith(' ');
  $('p, div, li, h1, h2, h3, h4, h5, h6, section, article, header, footer, td, th, tr, dl, dt, dd').append(' ');
  const raw = `${title} ${description} ${$('body').text()}`;
  // Keep a second representation for inline <span>ИНН</span><span>...</span>
  // labels. The text still excludes scripts and hidden content.
  const identityDom = $.root().clone();
  identityDom.find('*').prepend(' ').append(' ');
  const inns = [...new Set([...extractInns(raw), ...extractInns(identityDom.text())])];
  const ownerInns = new Set<string>();
  const collectOwnerInns = (text: string) => extractInns(text).forEach((inn) => ownerInns.add(inn));
  if (isLegalPage(url)) inns.forEach((inn) => ownerInns.add(inn));
  else {
    identityDom.find('footer, address, [role="contentinfo"]').each((_i, element) => collectOwnerInns($(element).text()));
    identityDom.find('div, section, aside, dl, table').each((_i, element) => {
      const markers = `${$(element).attr('id') ?? ''} ${$(element).attr('class') ?? ''}`;
      if (/(?:^|[\s_-])(?:footer|requisites?|rekvizit[yi]?|реквизиты)(?:$|[\s_-])/i.test(markers)) collectOwnerInns($(element).text());
    });
    // A labelled section is stronger than an arbitrary INN in a directory
    // card. Do not promote the entire body just because it has a heading.
    identityDom.find('h1, h2, h3, h4, h5, h6, dt, summary, legend').each((_i, element) => {
      if (!/^(?:(?:наши|банковские|юридические)\s+)?(?:реквизиты|requisites|legal details)\s*[:.]?$/i.test(cleanText($(element).text()))) return;
      const details = $(element).nextUntil('h1, h2, h3, h4, h5, h6, dt, summary, legend').slice(0, 4).text();
      if (details.length <= 12_000) collectOwnerInns(details);
    });
  }

  const origin = new URL(url);
  const terms = focusTerms(focus);
  const candidates = new Map<string, { url: string; text: string; score: number; order: number }>();
  $('a[href]').each((order, element) => {
    try {
      const href = $(element).attr('href') ?? '';
      if (href.length > 1_000) return;
      const target = new URL(href, origin);
      if (target.origin !== origin.origin || !/^https?:$/.test(target.protocol) || target.username || target.password) return;
      target.hash = '';
      if (target.href.length > 1_000) return;
      if (target.href === origin.href || /\.(?:pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|mp[34])$/i.test(target.pathname)) return;
      const label = cleanText($(element).text() || $(element).attr('title') || $(element).attr('aria-label')
        || $(element).find('img[alt]').map((_i, image) => $(image).attr('alt') ?? '').get().join(' ')).slice(0, 240);
      let path = target.pathname;
      try { path = decodeURIComponent(path); } catch { /* Use the literal path if malformed. */ }
      const searchable = `${label} ${path}`.toLowerCase();
      const topical = matchTerms(searchable, terms).filter(Boolean).length;
      const legal = /контакт|реквизит|юридич|лиценз|политик|contact|rekvizit|requisite|legal|license|licence|oferta|оферт|privacy|policy/.test(searchable);
      const services = /услуг|сервис|направлен|деятельност|продукц|товар|service|uslugi|product|solution/.test(searchable);
      const about = /о компании|about us/i.test(label) || /^\/(?:about|o-kompanii)\/?$/i.test(path);
      const depth = path.split('/').filter(Boolean).length;
      const score = topical * 100 + (legal ? 30 : 0) + (services ? 20 : 0) + (about ? 10 : 0) - Math.min(5, depth);
      const existing = candidates.get(target.href);
      if (!existing || score > existing.score) candidates.set(target.href, { url: target.href, text: label, score, order });
    } catch { /* Malformed and off-origin links are not discovery candidates. */ }
  });
  const links = [...candidates.values()].sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, 80).map(({ url: linkUrl, text }) => ({ url: linkUrl, text }));
  return { text: selectVeEvidenceText(raw, focus), url, links, inns, ownerInns: [...ownerInns] };
}
