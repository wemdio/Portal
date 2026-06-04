/**
 * @jest-environment node
 *
 * socialMediaExtractor — ловит ссылки на ОФИЦИАЛЬНЫЕ аккаунты компании во
 * всех поддерживаемых соцсетях и НЕ ловит share/intent ссылки. Тесты
 * фиксируют три инварианта:
 *
 *  1) Каждое семейство сетей: позитивный случай (URL вида аккаунта →
 *     попадает в результат в нормализованной форме).
 *  2) Share/intent guard: facebook.com/sharer, t.me/share/url,
 *     wa.me/?text=…, twitter.com/intent/tweet — НЕ попадают, даже если
 *     внутри есть валидный URL компании.
 *  3) Дедуп и порядок: один аккаунт, упомянутый дважды (с www / без, c
 *     UTM / без) → одна запись. Порядок — детерминированный (по семейству
 *     в порядке объявления паттернов).
 */

import { extractSocialMedia } from '@/lib/enrich/extractors/socialMediaExtractor';

const wrap = (links: string[]) =>
  `<footer>${links.map((href) => `<a href="${href}">x</a>`).join('')}</footer>`;

describe('extractSocialMedia — per-family positive cases', () => {
  it.each<[string, string]>([
    ['Telegram', 'https://t.me/mycompany'],
    ['Telegram invite-link', 'https://t.me/+abcXYZ123'],
    ['WhatsApp wa.me', 'https://wa.me/79991234567'],
    ['Instagram', 'https://instagram.com/mycompany'],
    ['Facebook', 'https://facebook.com/mycompany'],
    ['Facebook profile.php', 'https://facebook.com/profile.php?id=100012345'],
    ['Twitter', 'https://twitter.com/mycompany'],
    ['X.com', 'https://x.com/mycompany'],
    ['LinkedIn company', 'https://linkedin.com/company/mycompany'],
    ['LinkedIn personal', 'https://linkedin.com/in/myname'],
    ['YouTube @handle', 'https://youtube.com/@mychannel'],
    ['YouTube /channel/', 'https://youtube.com/channel/UCabcDEFghijklmn'],
    ['VK', 'https://vk.com/mycompany'],
    ['Odnoklassniki', 'https://ok.ru/group/123'],
    ['Dzen', 'https://dzen.ru/myblog'],
    ['RuTube', 'https://rutube.ru/channel/12345'],
    ['TikTok', 'https://tiktok.com/@mycompany'],
    ['Pinterest', 'https://pinterest.com/mycompany'],
    ['Discord invite', 'https://discord.gg/abcDEF'],
    ['GitHub', 'https://github.com/myorg'],
    ['Behance', 'https://behance.net/mystudio'],
    ['Dribbble', 'https://dribbble.com/myteam'],
    ['Medium @handle', 'https://medium.com/@myhandle'],
    ['Threads', 'https://threads.net/@mycompany'],
  ])('captures %s', (_label, url) => {
    const html = wrap([url]);
    const result = extractSocialMedia(html);
    expect(result).toHaveLength(1);
    // Нормализованный URL без trailing slash и без query.
    expect(result[0]).toMatch(/^https:\/\/[^/]+\/.+/);
  });
});

describe('extractSocialMedia — share/intent guard (must NOT capture)', () => {
  it.each<[string, string]>([
    ['Facebook sharer', 'https://www.facebook.com/sharer/sharer.php?u=https://my.site'],
    ['Facebook share.php', 'https://facebook.com/share.php?u=https://my.site'],
    ['Twitter intent tweet', 'https://twitter.com/intent/tweet?text=hi'],
    ['X intent like', 'https://x.com/intent/like?tweet_id=1'],
    ['LinkedIn shareArticle', 'https://www.linkedin.com/shareArticle?url=https://my.site'],
    ['LinkedIn sharing', 'https://www.linkedin.com/sharing/share-offsite/?url=x'],
    ['VK share.php', 'https://vk.com/share.php?url=https://my.site'],
    ['WhatsApp share text', 'https://wa.me/?text=hello'],
    ['WhatsApp api send text', 'https://api.whatsapp.com/send?text=hi'],
    ['Telegram share/url', 'https://t.me/share/url?url=https://my.site'],
    ['Pinterest pin create', 'https://pinterest.com/pin/create/button/?url=x'],
    ['Reddit submit', 'https://www.reddit.com/submit?url=x'],
  ])('drops %s', (_label, url) => {
    const html = wrap([url]);
    expect(extractSocialMedia(html)).toEqual([]);
  });

  it('drops share buttons but keeps a real account link from the same footer', () => {
    const html = wrap([
      'https://www.facebook.com/sharer/sharer.php?u=https://my.site',
      'https://facebook.com/mycompany',
      'https://twitter.com/intent/tweet?text=read',
      'https://twitter.com/mycompany',
    ]);
    const result = extractSocialMedia(html);
    expect(result).toEqual(expect.arrayContaining([
      'https://facebook.com/mycompany',
      'https://twitter.com/mycompany',
    ]));
    expect(result).toHaveLength(2);
  });
});

describe('extractSocialMedia — normalization & dedup', () => {
  it('strips www, lowercases host, drops trailing slash and UTM', () => {
    const html = wrap([
      'http://www.instagram.com/mycompany/?utm_source=footer&utm_campaign=site',
      'https://INSTAGRAM.com/mycompany/',
    ]);
    const result = extractSocialMedia(html);
    expect(result).toEqual(['https://instagram.com/mycompany']);
  });

  it('preserves Facebook profile.php?id=N (id is essential)', () => {
    const html = wrap([
      'https://facebook.com/profile.php?id=100012345&ref=site',
    ]);
    expect(extractSocialMedia(html)).toEqual([
      'https://facebook.com/profile.php?id=100012345',
    ]);
  });

  it('dedupes the same account across multiple variants', () => {
    const html = wrap([
      'https://t.me/mycompany',
      'http://www.t.me/mycompany/',
      'https://t.me/mycompany?utm=x',
    ]);
    expect(extractSocialMedia(html)).toEqual(['https://t.me/mycompany']);
  });

  it('keeps two accounts of the same family if they are different handles', () => {
    const html = wrap([
      'https://linkedin.com/company/myco',
      'https://linkedin.com/in/john-ceo',
    ]);
    const result = extractSocialMedia(html);
    expect(result).toEqual(expect.arrayContaining([
      'https://linkedin.com/company/myco',
      'https://linkedin.com/in/john-ceo',
    ]));
    expect(result).toHaveLength(2);
  });

  it('returns families in deterministic order (Telegram → Instagram → YouTube → VK)', () => {
    // Если в HTML соцсети раскиданы в случайном порядке, сортировка идёт по
    // семейству в порядке объявления паттернов: telegram → whatsapp → instagram
    // → facebook → twitter → linkedin → youtube → vk → … Точный порядок —
    // в SOCIAL_PATTERNS, тест закрепляет ключевые позиции.
    const html = wrap([
      'https://vk.com/myco',
      'https://youtube.com/@mychannel',
      'https://instagram.com/myco',
      'https://t.me/myco',
    ]);
    const result = extractSocialMedia(html);
    expect(result).toEqual([
      'https://t.me/myco',
      'https://instagram.com/myco',
      'https://youtube.com/@mychannel',
      'https://vk.com/myco',
    ]);
  });
});

describe('extractSocialMedia — robustness', () => {
  it('returns empty array for empty input', () => {
    expect(extractSocialMedia('')).toEqual([]);
  });

  it('ignores mailto, tel, javascript, anchors and relative paths', () => {
    const html = `
      <a href="mailto:hello@my.site">Email</a>
      <a href="tel:+79991234567">Phone</a>
      <a href="javascript:void(0)">Click</a>
      <a href="#contacts">Contacts</a>
      <a href="/about">About</a>
      <a href="https://t.me/realcompany">Telegram</a>
    `;
    expect(extractSocialMedia(html)).toEqual(['https://t.me/realcompany']);
  });

  it('does not pick a specific YouTube video URL as a company account', () => {
    // youtu.be/<id> — это конкретный ролик, не аккаунт.
    const html = wrap([
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    ]);
    expect(extractSocialMedia(html)).toEqual([]);
  });

  it('does not capture twitter.com/something/status/N (single tweet, not account)', () => {
    // Текущая регулярка строго `^twitter.com/<handle>$` — твит /status/ не
    // совпадёт. Закрепляем как контрактный инвариант.
    const html = wrap(['https://twitter.com/handle/status/1234567890']);
    expect(extractSocialMedia(html)).toEqual([]);
  });

  it('script/style/noscript tags are ignored (text-only matches do not count)', () => {
    // Если ссылка только в text() <script>, она не должна попадать.
    const html = `
      <script>const tg = 'https://t.me/incode';</script>
      <a href="https://t.me/realacc">Telegram</a>
    `;
    expect(extractSocialMedia(html)).toEqual(['https://t.me/realacc']);
  });
});
