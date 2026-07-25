/**
 * Extract a domain "brand" (second-level name, no TLD) from the brief's
 * company_website or from manual client input.
 *
 * Accepted forms: full URLs (https://example.com/path), bare hosts
 * (www.example.com), and bare brand words (mycompany). Output is lowercase
 * latin [a-z0-9-], suitable for generating candidate domains.
 *
 * Cyrillic / non-ASCII input is rejected with a user-facing message asking
 * for latin characters (MVP: no punycode handling). Empty input is NOT an
 * error — it yields brand=null so the UI can show the manual-input field.
 */

import { normalizeWebsiteUrl } from '@/lib/clientBrief/autofill/fetchWebsiteHtml';

export type ExtractBrandResult =
  | { ok: true; brand: string | null }
  | { ok: false; error: string };

export const BRAND_LATIN_ONLY_ERROR =
  'Введите домен сайта или название компании латиницей (например, mycompany)';

export const BRAND_INVALID_ERROR =
  'Не удалось выделить название из этого адреса. Введите название компании латиницей (например, mycompany)';

/**
 * Well-known second-level zones where the brand sits one label deeper
 * (example.com.ru → brand is "example", not "com"). Deliberately short —
 * covers the common RU/CIS cases; anything else falls back to the plain
 * second-to-last label.
 */
const SECOND_LEVEL_ZONES = new Set([
  'com.ru', 'net.ru', 'org.ru', 'pp.ru', 'msk.ru', 'spb.ru',
  'com.ua', 'com.by', 'com.kz', 'co.uk', 'org.uk',
]);

const BRAND_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function validBrand(raw: string): string | null {
  const brand = raw.toLowerCase();
  if (brand.length > 63) return null;
  return BRAND_RE.test(brand) ? brand : null;
}

export function extractBrand(input: string | null | undefined): ExtractBrandResult {
  if (typeof input !== 'string') return { ok: true, brand: null };
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, brand: null };

  // MVP: no punycode. Ask the client to type a latin brand instead.
  if (!/^[\x00-\x7F]+$/.test(trimmed)) {
    return { ok: false, error: BRAND_LATIN_ONLY_ERROR };
  }

  // Bare brand word (no dots, no scheme): use as-is.
  if (/^[a-z0-9-]+$/i.test(trimmed)) {
    const brand = validBrand(trimmed);
    return brand ? { ok: true, brand } : { ok: false, error: BRAND_INVALID_ERROR };
  }

  const url = normalizeWebsiteUrl(trimmed);
  if (!url) return { ok: false, error: BRAND_LATIN_ONLY_ERROR };

  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return { ok: false, error: BRAND_INVALID_ERROR };
  }

  const labels = hostname.replace(/^www\./, '').split('.').filter(Boolean);
  if (labels.length === 0) return { ok: false, error: BRAND_INVALID_ERROR };

  const lastTwo = labels.slice(-2).join('.');
  const brandLabel =
    labels.length >= 3 && SECOND_LEVEL_ZONES.has(lastTwo)
      ? labels[labels.length - 3]
      : labels.length >= 2
        ? labels[labels.length - 2]
        : labels[0];

  const brand = validBrand(brandLabel);
  return brand ? { ok: true, brand } : { ok: false, error: BRAND_INVALID_ERROR };
}
