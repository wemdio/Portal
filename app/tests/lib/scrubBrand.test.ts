import { scrubBrand } from '@/lib/scrubBrand';

describe('scrubBrand (client white-label)', () => {
  it('scrubs a dynamic Instantly API error message', () => {
    expect(scrubBrand('Instantly API 400: bad request')).toBe(
      'система рассылки API 400: bad request',
    );
  });

  it('scrubs Instantly.ai', () => {
    expect(scrubBrand('Например: Instantly.ai подписка')).toBe(
      'Например: система рассылки подписка',
    );
  });

  it('is case-insensitive and global (catches every variant)', () => {
    expect(scrubBrand('instantly / Instantly / INSTANTLY')).toBe(
      'система рассылки / система рассылки / система рассылки',
    );
  });

  it('scrubs the account-not-configured message', () => {
    expect(scrubBrand('Instantly account "main" is not configured')).toBe(
      'система рассылки account "main" is not configured',
    );
  });

  it('leaves brand-free text untouched', () => {
    expect(scrubBrand('Не удалось запустить кампанию')).toBe('Не удалось запустить кампанию');
  });
});
