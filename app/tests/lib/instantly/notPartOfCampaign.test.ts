/** @jest-environment node */

/**
 * Предикат отказа «письмо не принадлежит кампании».
 *
 * От него зависит, уйдёт ли ответ клиента вообще: при совпадении роут /reply
 * переключается на отправку новым письмом, иначе отдаёт ошибку. Ложноотрицательный
 * — клиент снова упирается в тупик (инцидент 18.08.2026), ложноположительный —
 * молча шлём новое письмо там, где надо было показать настоящую ошибку.
 */

import { isNotPartOfCampaignError } from '@/lib/instantly/notPartOfCampaign';

describe('isNotPartOfCampaignError', () => {
  it('ловит боевой текст провайдера', () => {
    expect(
      isNotPartOfCampaignError(
        new Error(
          'Instantly API 400: {"statusCode":400,"error":"Bad Request","message":"The email you are replying to is not part of an Instantly campaign, so you cannot reply to it (missing campaign_id or list_id)"}',
        ),
      ),
    ).toBe(true);
  });

  it('ловит его же после вычистки имени вендора (scrubBrand)', () => {
    // Клиентский контур подменяет «Instantly» на «система рассылки» — предикат
    // не должен на это опираться.
    expect(
      isNotPartOfCampaignError(
        new Error('система рассылки API 400: … is not part of an система рассылки campaign, so you cannot reply to it'),
      ),
    ).toBe(true);
  });

  it('ловит по второй половине фразы, если первую перепишут', () => {
    expect(isNotPartOfCampaignError(new Error('400 Bad Request (missing campaign_id or list_id)'))).toBe(true);
  });

  it('строки вместо Error тоже принимает', () => {
    expect(isNotPartOfCampaignError('not part of a campaign')).toBe(true);
  });

  it('НЕ срабатывает на посторонних ошибках', () => {
    for (const m of [
      'Instantly API 429: rate limit exceeded',
      'Instantly API 401: unauthorized',
      'fetch failed',
      'Campaign not found',
      '',
    ]) {
      expect(isNotPartOfCampaignError(new Error(m))).toBe(false);
    }
  });

  it('не падает на null/undefined', () => {
    expect(isNotPartOfCampaignError(null)).toBe(false);
    expect(isNotPartOfCampaignError(undefined)).toBe(false);
  });
});
