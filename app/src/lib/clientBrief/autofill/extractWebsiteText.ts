/**
 * Pure HTML → text extraction for the client brief autofill flow.
 *
 * Conservative on purpose: only what's clearly textual on the page makes it
 * to the AI prompt. No JS execution, no link-following, no remote assets.
 * Designed to never throw, even on truncated/garbage input.
 */

export interface ExtractedWebsiteText {
  title: string;
  metaDescription: string;
  ogDescription: string;
  ogSiteName: string;
  body: string;
  combined: string;
}

export interface ExtractWebsiteTextOptions {
  /** Hard cap on the combined output size; defaults to 40k chars. */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 40_000;

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
  '&laquo;': '«',
  '&raquo;': '»',
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
  '&copy;': '©',
  '&reg;': '®',
  '&trade;': '™',
};

function decodeEntities(input: string): string {
  return input
    .replace(/&[a-zA-Z]+;|&#\d+;/g, (entity) => {
      if (ENTITY_MAP[entity]) return ENTITY_MAP[entity];
      const numeric = entity.match(/^&#(\d+);$/);
      if (numeric) {
        const code = Number(numeric[1]);
        if (Number.isFinite(code) && code > 0 && code < 0x10ffff) {
          try {
            return String.fromCodePoint(code);
          } catch {
            return '';
          }
        }
      }
      return ' ';
    });
}

function normalizeWhitespace(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripBlock(html: string, tag: string): string {
  // Greedy stripper for entire <tag>...</tag> blocks (case-insensitive).
  // Falls back to dropping a lonely <tag ...> if no closing tag exists.
  const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
  return html.replace(re, ' ');
}

function safeMatch(input: string, re: RegExp): string {
  const m = input.match(re);
  if (!m) return '';
  return decodeEntities(m[1] ?? '').trim();
}

function extractHead(html: string) {
  const headMatch = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  const head = headMatch?.[1] ?? html;

  const title = safeMatch(head, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const metaDescription = safeMatch(
    head,
    /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*\bcontent\s*=\s*["']([^"']*)["'][^>]*>/i,
  ) || safeMatch(
    head,
    /<meta\b[^>]*\bcontent\s*=\s*["']([^"']*)["'][^>]*\bname\s*=\s*["']description["'][^>]*>/i,
  );

  const ogDescription = safeMatch(
    head,
    /<meta\b[^>]*\bproperty\s*=\s*["']og:description["'][^>]*\bcontent\s*=\s*["']([^"']*)["'][^>]*>/i,
  ) || safeMatch(
    head,
    /<meta\b[^>]*\bcontent\s*=\s*["']([^"']*)["'][^>]*\bproperty\s*=\s*["']og:description["'][^>]*>/i,
  );

  const ogSiteName = safeMatch(
    head,
    /<meta\b[^>]*\bproperty\s*=\s*["']og:site_name["'][^>]*\bcontent\s*=\s*["']([^"']*)["'][^>]*>/i,
  ) || safeMatch(
    head,
    /<meta\b[^>]*\bcontent\s*=\s*["']([^"']*)["'][^>]*\bproperty\s*=\s*["']og:site_name["'][^>]*>/i,
  );

  return { title, metaDescription, ogDescription, ogSiteName };
}

function extractBody(html: string): string {
  // Carve out body if available, otherwise treat the whole document as body.
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  let body = bodyMatch?.[1] ?? html;

  // Drop entire blocks that are not textual content the user cares about.
  for (const tag of ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'head']) {
    body = stripBlock(body, tag);
  }
  // Drop self-closing svg/path noise that might be left over.
  body = body.replace(/<(svg|path|polygon|polyline|circle|rect|ellipse|line|g)\b[^>]*\/?>/gi, ' ');

  // Insert a newline at common block boundaries before stripping all tags,
  // so the text doesn't collapse into a single line.
  body = body.replace(
    /<(\/?)(?:p|div|li|tr|td|th|h[1-6]|section|article|header|footer|nav|main|aside|blockquote|pre|br|hr)\b[^>]*>/gi,
    '\n',
  );

  // Strip all remaining tags.
  body = body.replace(/<[^>]+>/g, ' ');

  body = decodeEntities(body);
  return normalizeWhitespace(body);
}

export function extractWebsiteText(
  html: string,
  options: ExtractWebsiteTextOptions = {},
): ExtractedWebsiteText {
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_MAX_CHARS);
  const safeInput = typeof html === 'string' ? html : '';

  try {
    const { title, metaDescription, ogDescription, ogSiteName } = extractHead(safeInput);
    const body = extractBody(safeInput);

    const combinedParts: string[] = [];
    if (title) combinedParts.push(`Title: ${title}`);
    if (metaDescription) combinedParts.push(`Meta description: ${metaDescription}`);
    if (ogDescription && ogDescription !== metaDescription) {
      combinedParts.push(`OG description: ${ogDescription}`);
    }
    if (ogSiteName) combinedParts.push(`OG site name: ${ogSiteName}`);
    if (body) combinedParts.push(`Body:\n${body}`);
    let combined = combinedParts.join('\n\n').trim();
    if (combined.length > maxChars) {
      combined = combined.slice(0, maxChars);
    }

    return {
      title,
      metaDescription,
      ogDescription,
      ogSiteName,
      body,
      combined,
    };
  } catch {
    return {
      title: '',
      metaDescription: '',
      ogDescription: '',
      ogSiteName: '',
      body: '',
      combined: '',
    };
  }
}
