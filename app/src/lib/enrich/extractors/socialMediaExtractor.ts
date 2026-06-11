/**
 * Social media link extractor.
 *
 * Сканирует HTML страницы и возвращает список нормализованных URL'ов
 * официальных соцсетей компании. Цель — ссылки на АККАУНТЫ компании,
 * НЕ кнопки шаринга («поделиться в Facebook», «отправить в WhatsApp с
 * текстом X»), которые на каждой странице сидят рядом с реальными
 * ссылками на профиль.
 *
 * Поддерживаются:
 *   Telegram, WhatsApp, Instagram, Facebook, Twitter/X, LinkedIn (in+company),
 *   YouTube, VK, Одноклассники, Дзен, RuTube, TikTok, Pinterest, Discord,
 *   GitHub, Behance, Dribbble, Medium, Threads, Telegram Channel (t.me/+).
 *
 * Возвращаемое значение — массив строк (нормализованные URL без trailing
 * slash, без UTM-параметров, без query-флагов share/intent). Дедуп — по
 * нормализованному URL. Порядок — детерминированный (по семейству сетей в
 * том порядке, как они объявлены в SOCIAL_PATTERNS), внутри семейства — в
 * порядке появления в HTML.
 */

import * as cheerio from 'cheerio';

/** Семейство соцсети. Один аккаунт = одна запись в этом enum'е. */
type SocialFamily =
  | 'telegram'
  | 'whatsapp'
  | 'instagram'
  | 'facebook'
  | 'twitter'
  | 'linkedin'
  | 'youtube'
  | 'vk'
  | 'ok'
  | 'dzen'
  | 'rutube'
  | 'tiktok'
  | 'pinterest'
  | 'discord'
  | 'github'
  | 'behance'
  | 'dribbble'
  | 'medium'
  | 'threads';

interface SocialPattern {
  family: SocialFamily;
  /**
   * URL matcher: первый capture group — handle/identifier аккаунта (для
   * нормализации). Не учитывает протокол (http/https) и www — это
   * приводится к канону в normalizeUrl.
   */
  match: RegExp;
  /**
   * Если true — handle обязателен. Иначе принимаем «голую» ссылку на
   * домен без handle'а (например `t.me/` без юзернейма не считается, а
   * `youtube.com/` без канала — может (это значит «домашняя» компании на
   * YouTube если есть user/channel/@handle где-то ещё).
   */
  requireHandle?: boolean;
}

/**
 * Порядок ВАЖЕН — он определяет порядок соцсетей в итоговой строке.
 * Менять только по согласованию с продуктом (UI: оператор привык что
 * Telegram/WhatsApp сразу). Также: more-specific патерны должны идти ПЕРЕД
 * less-specific (linkedin/company перед linkedin вообще).
 */
const SOCIAL_PATTERNS: SocialPattern[] = [
  // Telegram: t.me/<handle> или t.me/+<invite> (приватный канал)
  {
    family: 'telegram',
    match: /^https?:\/\/(?:www\.)?t\.me\/(\+?[A-Za-z0-9_]+)\/?(?:\?.*)?$/i,
    requireHandle: true,
  },
  {
    family: 'telegram',
    match: /^https?:\/\/(?:www\.)?telegram\.(?:me|org)\/(\+?[A-Za-z0-9_]+)\/?(?:\?.*)?$/i,
    requireHandle: true,
  },
  // WhatsApp: wa.me/<phone> (account/contact)
  // Шаринг wa.me/?text=… или whatsapp.com/send?text=… НЕ считаем — это
  // отправка готового сообщения, не контакт.
  {
    family: 'whatsapp',
    match: /^https?:\/\/(?:www\.)?wa\.me\/(\+?\d{6,15})(?:\?.*)?$/i,
    requireHandle: true,
  },
  {
    family: 'whatsapp',
    match: /^https?:\/\/(?:api\.|chat\.)?whatsapp\.com\/(?:send\/?\?phone=|message\/)(\+?\d{6,15})/i,
    requireHandle: true,
  },
  // Instagram: instagram.com/<handle>
  {
    family: 'instagram',
    match: /^https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]+)\/?(?:\?.*)?$/i,
    requireHandle: true,
  },
  // Facebook: facebook.com/<handle> или fb.com/<handle>; profile.php?id=N
  {
    family: 'facebook',
    match: /^https?:\/\/(?:www\.|m\.)?facebook\.com\/(?:profile\.php\?id=)(\d+)/i,
    requireHandle: true,
  },
  {
    family: 'facebook',
    match: /^https?:\/\/(?:www\.|m\.)?(?:facebook|fb)\.com\/([A-Za-z0-9.\-_]+)\/?(?:\?.*)?$/i,
    requireHandle: true,
  },
  // Twitter / X (один family — handle общий)
  {
    family: 'twitter',
    match: /^https?:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})\/?(?:\?.*)?$/i,
    requireHandle: true,
  },
  // LinkedIn: только /company /school /showcase. Личные /in/ — это люди, не
  // соцсеть компании; для outreach это шум, поэтому /in/ исключён.
  {
    family: 'linkedin',
    match: /^https?:\/\/(?:www\.|[a-z]{2}\.)?linkedin\.com\/(?:company|school|showcase)\/([A-Za-z0-9\-_.%]+)\/?(?:\?.*)?$/i,
    requireHandle: true,
  },
  // YouTube: youtube.com/@handle, /c/handle, /channel/UC..., /user/...
  {
    family: 'youtube',
    match: /^https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:@[A-Za-z0-9\-_.]+|c\/[A-Za-z0-9\-_.]+|channel\/[A-Za-z0-9\-_.]+|user\/[A-Za-z0-9\-_.]+)\/?(?:\?.*)?$/i,
  },
  // youtu.be/<id> — это конкретный ролик, не аккаунт. Не берём.
  // VK: vk.com/<handle> и vk.com/public<id>
  {
    family: 'vk',
    match: /^https?:\/\/(?:www\.|m\.)?(?:vk\.com|vkontakte\.ru)\/([A-Za-z0-9_.]+)\/?(?:\?.*)?$/i,
    requireHandle: true,
  },
  // Odnoklassniki: ok.ru/<handle> или /group/<id> или /profile/<id>
  {
    family: 'ok',
    match: /^https?:\/\/(?:www\.|m\.)?(?:ok\.ru|odnoklassniki\.ru)\/([A-Za-z0-9_./]+)\/?(?:\?.*)?$/i,
    requireHandle: true,
  },
  // Dzen.ru / Yandex Zen
  {
    family: 'dzen',
    match: /^https?:\/\/(?:www\.)?(?:dzen\.ru|zen\.yandex\.(?:ru|com))\/([A-Za-z0-9\-_.@%]+)\/?(?:\?.*)?$/i,
    requireHandle: true,
  },
  // RuTube channel
  {
    family: 'rutube',
    match: /^https?:\/\/(?:www\.)?rutube\.ru\/(?:channel\/[A-Za-z0-9\-_.]+|u\/[A-Za-z0-9\-_.]+)\/?(?:\?.*)?$/i,
  },
  // TikTok: tiktok.com/@handle
  {
    family: 'tiktok',
    match: /^https?:\/\/(?:www\.|m\.)?tiktok\.com\/@([A-Za-z0-9_.]+)\/?(?:\?.*)?$/i,
    requireHandle: true,
  },
  // Pinterest: pinterest.com/<handle>
  {
    family: 'pinterest',
    match: /^https?:\/\/(?:www\.|[a-z]{2}\.)?pinterest\.com\/([A-Za-z0-9_\-./]+)\/?(?:\?.*)?$/i,
    requireHandle: true,
  },
  // Discord invite: discord.gg/<id> или discord.com/invite/<id>
  {
    family: 'discord',
    match: /^https?:\/\/(?:www\.)?(?:discord\.gg|discord\.com\/invite)\/([A-Za-z0-9]+)\/?(?:\?.*)?$/i,
    requireHandle: true,
  },
  // GitHub org/user (без /<repo> — это конкретный репозиторий, не аккаунт)
  {
    family: 'github',
    match: /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9\-_.]+)\/?(?:\?.*)?$/i,
    requireHandle: true,
  },
  // Behance: behance.net/<handle>
  {
    family: 'behance',
    match: /^https?:\/\/(?:www\.)?behance\.net\/([A-Za-z0-9\-_.]+)\/?(?:\?.*)?$/i,
    requireHandle: true,
  },
  // Dribbble: dribbble.com/<handle>
  {
    family: 'dribbble',
    match: /^https?:\/\/(?:www\.)?dribbble\.com\/([A-Za-z0-9\-_.]+)\/?(?:\?.*)?$/i,
    requireHandle: true,
  },
  // Medium: medium.com/@handle или handle.medium.com
  {
    family: 'medium',
    match: /^https?:\/\/(?:www\.)?medium\.com\/@?([A-Za-z0-9\-_.]+)\/?(?:\?.*)?$/i,
    requireHandle: true,
  },
  // Threads: threads.net/@handle
  {
    family: 'threads',
    match: /^https?:\/\/(?:www\.)?threads\.net\/@([A-Za-z0-9_.]+)\/?(?:\?.*)?$/i,
    requireHandle: true,
  },
];

/**
 * URL'ы, которые НИКОГДА не считаются ссылкой на аккаунт компании, даже
 * если их домен совпадает с социальной сетью. Это кнопки шаринга и intent-
 * страницы. Без этого guard'а каждый сайт с share-кнопкой «поделиться в
 * Facebook» добавлял бы facebook.com/sharer/sharer.php… как «соцсеть».
 */
const SHARE_INTENT_PATTERNS: RegExp[] = [
  // Facebook share buttons
  /facebook\.com\/sharer\b/i,
  /facebook\.com\/share\.php\b/i,
  // Twitter / X intent (compose tweet)
  /(?:twitter|x)\.com\/intent\/(?:tweet|like|follow|retweet)\b/i,
  /(?:twitter|x)\.com\/share\b/i,
  // LinkedIn share
  /linkedin\.com\/share(?:Article|ing)?\b/i,
  // VK share
  /vk\.com\/share\.php\b/i,
  // WhatsApp share (отправка готового текста, не контакт)
  /wa\.me\/\?text=/i,
  /(?:api\.)?whatsapp\.com\/send\/?\?(?!phone=)/i,
  // Telegram share
  /t\.me\/share\/url\b/i,
  // Pinterest share
  /pinterest\.com\/pin\/create\b/i,
  // OK share
  /(?:ok\.ru|odnoklassniki\.ru)\/(?:dk|offer)\b/i,
  // Reddit share — мы reddit не extract'им, но share по нему может быть
  /reddit\.com\/submit\b/i,
  // Generic share/widget paths
  /\/share\.html?\b/i,
];

// Потолки на одну компанию: ≤2 аккаунта на сеть и ≤8 всего — отсекает «пакеты»
// чужих/дублирующих ссылок (встроенные виджеты, агрегаторы).
const MAX_PER_FAMILY = 2;
const MAX_TOTAL = 8;

function isShareIntent(url: string): boolean {
  return SHARE_INTENT_PATTERNS.some((re) => re.test(url));
}

/**
 * Нормализация URL под канонический вид. Цель — две разные строки на одну
 * и ту же страницу аккаунта (`http://` vs `https://`, с/без `www`, с/без
 * trailing slash, с/без UTM) должны дать одну и ту же нормализованную форму
 * → дедуп их по этой форме.
 */
function normalizeUrl(raw: string): string {
  let s = raw.trim();
  if (!s) return '';
  // Срезаем якоря (#…). Query обрабатываем ниже в URL-парсере, не голым
  // indexOf — иначе теряем особые параметры типа Facebook profile.php?id=N
  // (без id ссылка вырождается в /profile.php → не аккаунт).
  const hashIdx = s.indexOf('#');
  if (hashIdx >= 0) s = s.slice(0, hashIdx);
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    let query = '';
    // Facebook profile.php?id=N: id — primary key страницы, сохраняем.
    // Все остальные query (utm_*, ref, share-source, lang) выкидываем.
    if (host.endsWith('facebook.com') && /\/profile\.php$/i.test(path)) {
      const id = u.searchParams.get('id');
      if (id && /^\d+$/.test(id)) {
        query = `?id=${id}`;
      }
    }
    return `https://${host}${path}${query}`;
  } catch {
    // Защитный fallback на голую обрезку, если new URL() не справился
    // (нестандартные схемы и т.п.).
    const qIdx = s.indexOf('?');
    if (qIdx >= 0) s = s.slice(0, qIdx);
    while (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  }
}

/**
 * Достать family + нормализованный URL из произвольной строки. Возвращает
 * null если это не соцсеть или это share/intent.
 */
function classifyUrl(url: string): { family: SocialFamily; normalized: string } | null {
  if (!url) return null;
  if (isShareIntent(url)) return null;
  // Сначала нормализуем, потом ищем match — паттерны рассчитаны на
  // канонический формат `https://host/path`.
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  for (const pat of SOCIAL_PATTERNS) {
    const m = normalized.match(pat.match);
    if (!m) continue;
    if (pat.requireHandle && (!m[1] || m[1].length === 0)) continue;
    // Telegram-боты (@…bot) — не канал компании, выкидываем.
    if (pat.family === 'telegram' && /bot$/i.test(m[1] ?? '')) return null;
    return { family: pat.family, normalized };
  }
  return null;
}

/**
 * Классифицировать произвольный список URL'ов в очищенный, упорядоченный и
 * ограниченный список соцсетей компании. Дедуп по нормализованной форме,
 * потолки MAX_PER_FAMILY / MAX_TOTAL, порядок — по SOCIAL_PATTERNS. Боты,
 * личные LinkedIn /in/, share/intent уже отсеяны в classifyUrl. Используется
 * и HTML-извлекателем, и поиском каналов через Serper (DRY).
 */
export function filterSocialUrls(rawUrls: string[]): string[] {
  const byFamily = new Map<SocialFamily, string[]>();
  const seen = new Set<string>();
  for (const raw of rawUrls) {
    const c = classifyUrl(raw);
    if (!c) continue;
    if (seen.has(c.normalized)) continue;
    seen.add(c.normalized);
    const arr = byFamily.get(c.family) ?? [];
    if (arr.length >= MAX_PER_FAMILY) continue;
    arr.push(c.normalized);
    byFamily.set(c.family, arr);
  }
  const out: string[] = [];
  const written = new Set<SocialFamily>();
  for (const pat of SOCIAL_PATTERNS) {
    if (written.has(pat.family)) continue;
    written.add(pat.family);
    const arr = byFamily.get(pat.family);
    if (arr) out.push(...arr);
  }
  return out.slice(0, MAX_TOTAL);
}

/**
 * Найти ссылки на соцсети в HTML. Сначала ищем в «фирменных» зонах
 * (footer/header/nav + контейнеры/ссылки с social/contact в class/id) — там
 * живут соцсети компании. Если там пусто — обходим всю страницу. Это отсекает
 * чужие соцсети из тела статей/встроенных виджетов (кейс Хабра), не ломая
 * обычные сайты с иконками в подвале.
 */
export function extractSocialMedia(html: string): string[] {
  if (!html) return [];
  const $ = cheerio.load(html);
  $('script, style, noscript, template').remove();

  const hrefs = (sel: string): string[] => {
    const out: string[] = [];
    $(sel).each((_, a) => {
      const href = ($(a).attr('href') ?? '').trim();
      if (/^https?:\/\//i.test(href)) out.push(href);
    });
    return out;
  };

  const REGION =
    'footer a, header a, nav a, [class*="social"] a, [id*="social"] a, ' +
    '[class*="contact"] a, [id*="contact"] a, a[class*="social"], a[id*="social"]';

  let urls = filterSocialUrls(hrefs(REGION));
  if (urls.length === 0) urls = filterSocialUrls(hrefs('a'));
  return urls;
}
