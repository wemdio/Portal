import {
  isTransientEnrichmentError,
  shouldRetryEnrichmentItem,
  shouldUseCachedError,
} from '@/lib/enrich/errorPolicy';

describe('enrichment error policy', () => {
  it('detects transient network/timeout errors', () => {
    expect(isTransientEnrichmentError('Превышено время ожидания сайта (20с)')).toBe(true);
    expect(isTransientEnrichmentError('Не удалось получить HTML с сайта')).toBe(true);
    expect(isTransientEnrichmentError('fetch failed')).toBe(true);
  });

  it('marks non-transient errors as cacheable', () => {
    expect(shouldUseCachedError('Невалидный URL: example')).toBe(true);
    expect(shouldUseCachedError('Не поддерживается протокол')).toBe(true);
    expect(shouldUseCachedError('Превышено время ожидания сайта (20с)')).toBe(false);
  });

  it('retries only transient errors within max attempts', () => {
    expect(shouldRetryEnrichmentItem('Превышено время ожидания сайта (20с)', 1, 3)).toBe(true);
    expect(shouldRetryEnrichmentItem('Превышено время ожидания сайта (20с)', 3, 3)).toBe(false);
    expect(shouldRetryEnrichmentItem('Невалидный URL', 1, 3)).toBe(false);
  });
});
