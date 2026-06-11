import * as cheerio from 'cheerio';

// Общие «не-бренд» сегменты title — пропускаем при выборе имени компании.
const STOPWORDS = new Set([
  'главная', 'home', 'контакты', 'contacts', 'contact', 'о компании', 'о нас',
  'about', 'about us', 'услуги', 'services', 'цены', 'pricing', 'блог', 'blog',
]);

/** Имя компании со страницы: og:site_name → первый «осмысленный» сегмент
 *  title → корень домена. Для поисковых запросов (Serper), не для отображения. */
export function deriveCompanyName(html: string, url: string): string {
  if (html) {
    const $ = cheerio.load(html);
    const og = ($('meta[property="og:site_name"]').attr('content') ?? '').trim();
    if (og.length >= 2) return clean(og);
    const appName = ($('meta[name="application-name"]').attr('content') ?? '').trim();
    if (appName.length >= 2) return clean(appName);
    const title = ($('title').first().text() ?? '').trim();
    if (title) {
      const segs = title
        .split(/\s*[—\-|:·»]\s*/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 2 && !STOPWORDS.has(s.toLowerCase()));
      if (segs.length > 0) return clean(segs[0]);
    }
  }
  return domainRoot(url);
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** Корневой токен домена ("www.komus-contact.ru" → "komus-contact"). */
export function domainRoot(url: string): string {
  try {
    const host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
    const parts = host.split('.');
    return parts.length >= 2 ? parts[parts.length - 2] : host;
  } catch {
    return '';
  }
}
