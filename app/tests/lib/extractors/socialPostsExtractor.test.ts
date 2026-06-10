/** @jest-environment node */

jest.mock('server-only', () => ({}));

jest.mock('@/lib/enrich/websiteParser', () => ({
  fetchHtmlWithRetry: jest.fn(),
}));

import { extractSocialPosts } from '@/lib/enrich/extractors/socialPostsExtractor';
import { fetchHtmlWithRetry } from '@/lib/enrich/websiteParser';

const fetchMock = fetchHtmlWithRetry as jest.MockedFunction<typeof fetchHtmlWithRetry>;

beforeEach(() => {
  fetchMock.mockReset();
});

describe('extractSocialPosts — supported network parsers', () => {
  it('returns empty array for empty / missing input', async () => {
    expect(await extractSocialPosts([])).toEqual([]);
    expect(await extractSocialPosts([] as never)).toEqual([]);
  });

  it('skips unsupported networks (Instagram / Facebook / YouTube) without fetching', async () => {
    const out = await extractSocialPosts([
      'https://instagram.com/somebrand',
      'https://facebook.com/somebrand',
      'https://www.youtube.com/@somebrand',
      'https://github.com/somebrand',
    ]);
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses Telegram posts from t.me/s/ preview and canonicalises bare t.me/<handle>', async () => {
    const html = `
      <html><body>
        <div class="tgme_widget_message">
          <div class="tgme_widget_message_text">Открываем новый филиал на Тверской в августе! Готовим запуск.</div>
          <time datetime="2026-05-12T10:00:00+00:00">May 12</time>
        </div>
        <div class="tgme_widget_message">
          <div class="tgme_widget_message_text">Сегодня в команде уже 15 человек. Спасибо вам ❤️</div>
          <time datetime="2026-04-30T09:00:00+00:00">Apr 30</time>
        </div>
      </body></html>
    `;
    fetchMock.mockResolvedValue({ html, status: 200 });

    const result = await extractSocialPosts(['https://t.me/some_horeca_brand']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Canonicalised to the SSR-preview URL t.me/s/<handle>
    expect((fetchMock.mock.calls[0][0] as string)).toBe('https://t.me/s/some_horeca_brand');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      network: 'telegram',
      url: 'https://t.me/s/some_horeca_brand',
      text: 'Открываем новый филиал на Тверской в августе! Готовим запуск.',
      date: '2026-05-12',
    });
    expect(result[1].date).toBe('2026-04-30');
  });

  it('caps Telegram posts at maxPostsPerNetwork', async () => {
    const items = Array.from({ length: 25 }, (_, i) => `
      <div class="tgme_widget_message">
        <div class="tgme_widget_message_text">Пост ${i} — какой-то текст для теста длиной более 10 символов.</div>
        <time datetime="2026-05-${String(i + 1).padStart(2, '0')}T10:00:00Z">May ${i + 1}</time>
      </div>
    `).join('');
    fetchMock.mockResolvedValue({ html: `<body>${items}</body>`, status: 200 });

    const result = await extractSocialPosts(['https://t.me/somebrand'], {
      maxPostsPerNetwork: 5,
    });

    expect(result).toHaveLength(5);
  });

  it('skips private Telegram channels (t.me/+invite — no public mirror)', async () => {
    const result = await extractSocialPosts(['https://t.me/+abc123']);
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses VK mobile group page', async () => {
    const html = `
      <body>
        <div class="wall_item">
          <div class="pi_text">Открыли третий филиал в Казани! Адрес: Баумана, 18.</div>
          <a class="wi_date">16 апреля в 15:42</a>
        </div>
        <div class="wall_item">
          <div class="pi_text">Идёт реновация — закрываемся до 1 июля для большого ремонта.</div>
          <a class="wi_date">5 мая в 09:00</a>
        </div>
      </body>
    `;
    fetchMock.mockResolvedValue({ html, status: 200 });

    const result = await extractSocialPosts(['https://vk.com/some_horeca_brand']);

    expect((fetchMock.mock.calls[0][0] as string)).toBe('https://m.vk.com/some_horeca_brand');
    expect(result).toHaveLength(2);
    expect(result[0].network).toBe('vk');
    expect(result[0].text).toContain('Открыли третий филиал');
    expect(result[1].text).toContain('реновация');
  });

  it('skips VK utility paths (share / search / login)', async () => {
    const result = await extractSocialPosts([
      'https://vk.com/share',
      'https://vk.com/login',
    ]);
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses OK (Odnoklassniki) mobile group page', async () => {
    const html = `
      <body>
        <div class="mfeed_i">
          <span class="mtext_w">Готовим ребрендинг — новое имя и логотип объявим в сентябре.</span>
          <span class="mts_date">29 ноя</span>
        </div>
      </body>
    `;
    fetchMock.mockResolvedValue({ html, status: 200 });

    const result = await extractSocialPosts(['https://ok.ru/group/12345']);
    expect(result).toHaveLength(1);
    expect(result[0].network).toBe('ok');
    expect(result[0].text).toContain('ребрендинг');
  });

  it('parses Dzen channel page (title + excerpt joined)', async () => {
    const html = `
      <body>
        <article>
          <h2 class="card-feed__title">Скоро открытие нового зала</h2>
          <p class="card-feed__excerpt">Запуск планируется на октябрь 2026, готовим презентацию.</p>
          <time datetime="2026-05-20">May 20</time>
        </article>
      </body>
    `;
    fetchMock.mockResolvedValue({ html, status: 200 });

    const result = await extractSocialPosts(['https://dzen.ru/somebrand']);
    expect(result).toHaveLength(1);
    expect(result[0].network).toBe('dzen');
    expect(result[0].text).toContain('Скоро открытие');
    expect(result[0].text).toContain('октябрь');
    expect(result[0].date).toBe('2026-05-20');
  });

  it('fetches all networks in parallel and merges results', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('t.me/s/')) {
        return {
          status: 200,
          html: `<div class="tgme_widget_message"><div class="tgme_widget_message_text">TG post about opening new location</div><time datetime="2026-05-01T00:00:00Z"></time></div>`,
        };
      }
      if (url.includes('m.vk.com')) {
        return {
          status: 200,
          html: `<div class="wall_item"><div class="pi_text">VK post about renovation</div><a class="wi_date">сегодня в 10:00</a></div>`,
        };
      }
      return null;
    });

    const result = await extractSocialPosts([
      'https://t.me/somebrand',
      'https://vk.com/somebrand',
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.network).sort()).toEqual(['telegram', 'vk']);
  });

  it('skips posts that are too short to be meaningful (< 10 chars)', async () => {
    const html = `
      <div class="tgme_widget_message"><div class="tgme_widget_message_text">👍</div></div>
      <div class="tgme_widget_message"><div class="tgme_widget_message_text">5</div></div>
      <div class="tgme_widget_message"><div class="tgme_widget_message_text">Полноценный пост с описанием события открытия.</div></div>
    `;
    fetchMock.mockResolvedValue({ html, status: 200 });

    const result = await extractSocialPosts(['https://t.me/somebrand']);

    expect(result).toHaveLength(1);
    expect(result[0].text).toContain('открытия');
  });

  it('truncates post text to a sane maximum length so spreadsheet cells stay bounded', async () => {
    const longText = 'А'.repeat(5000);
    const html = `
      <div class="tgme_widget_message">
        <div class="tgme_widget_message_text">${longText}</div>
        <time datetime="2026-05-01T00:00:00Z"></time>
      </div>
    `;
    fetchMock.mockResolvedValue({ html, status: 200 });

    const result = await extractSocialPosts(['https://t.me/somebrand']);

    expect(result).toHaveLength(1);
    expect(result[0].text.length).toBeLessThanOrEqual(2000);
  });

  it('survives fetch failures for one network without losing others', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('t.me')) throw new Error('boom');
      return {
        status: 200,
        html: `<div class="wall_item"><div class="pi_text">A real VK post about opening</div></div>`,
      };
    });

    const result = await extractSocialPosts([
      'https://t.me/somebrand',
      'https://vk.com/somebrand',
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].network).toBe('vk');
  });
});
