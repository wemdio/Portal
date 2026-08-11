/** @jest-environment node */

/**
 * Сохранение аватарки в хранилище портала.
 *
 * До 11.08.2026 функция на любой сбой возвращала null, а вызывающий код писал в
 * аккаунт пустую ссылку. Отсутствующий бакет выглядел для оператора ровно как
 * «в Telegram нет аватарки» — именно так и проявился баг на проде, где бакет
 * `avatars` не пережил переезд на self-hosted. Здесь фиксируем, что причина
 * доезжает до вызывающего.
 */

const mockUpload = jest.fn();
const mockGetPublicUrl = jest.fn();
const mockState = { configured: true };

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockState.configured
      ? { storage: { from: () => ({ upload: mockUpload, getPublicUrl: mockGetPublicUrl }) } }
      : null;
  },
}));

import { storeAccountAvatar } from '@/lib/tgOutreach/profile/avatarStorage';

const JPEG = Buffer.from([0xff, 0xd8, 0xff]);

describe('storeAccountAvatar', () => {
  beforeEach(() => {
    mockState.configured = true;
    mockUpload.mockReset().mockResolvedValue({ error: null });
    mockGetPublicUrl.mockReset().mockReturnValue({
      data: { publicUrl: 'https://portal/storage/v1/object/public/avatars/tg-outreach-avatars/a1.jpg' },
    });
  });

  it('возвращает ссылку с меткой версии, чтобы браузер не показывал старое фото', async () => {
    const res = await storeAccountAvatar('a1', JPEG);
    expect(res.error).toBeNull();
    expect(res.url).toMatch(/tg-outreach-avatars\/a1\.jpg\?v=\d+$/);
  });

  it('называет причину, когда хранилище не приняло файл', async () => {
    mockUpload.mockResolvedValue({ error: { message: 'Bucket not found' } });
    const res = await storeAccountAvatar('a1', JPEG);
    expect(res.url).toBeNull();
    expect(res.error).toContain('Bucket not found');
    expect(res.error).toContain('avatars');
  });

  it('называет причину, когда служебного ключа нет', async () => {
    mockState.configured = false;
    const res = await storeAccountAvatar('a1', JPEG);
    expect(res.url).toBeNull();
    expect(res.error).toMatch(/не настроено/);
  });

  it('называет причину, когда хранилище не отдало публичную ссылку', async () => {
    mockGetPublicUrl.mockReturnValue({ data: null });
    const res = await storeAccountAvatar('a1', JPEG);
    expect(res.url).toBeNull();
    expect(res.error).toMatch(/публичную ссылку/);
  });
});
