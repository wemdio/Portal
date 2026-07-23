import { extractUtm } from '@/lib/leadsReport/extractUtm';

describe('extractUtm', () => {
  it('извлекает из custom_fields_values по field_name', () => {
    const raw = {
      custom_fields_values: [
        { field_name: 'utm_source', values: [{ value: 'yandex' }] },
        { field_name: 'utm_medium', values: [{ value: 'cpc' }] },
        { field_name: 'utm_campaign', values: [{ value: '119782678' }] },
      ],
    };
    expect(extractUtm(raw)).toEqual({
      source: 'yandex',
      medium: 'cpc',
      campaign: '119782678',
      content: null,
      term: null,
    });
  });

  it('извлекает из текста комментария (fallback)', () => {
    const raw = {
      custom_fields_values: [
        {
          field_name: 'Комментарий',
          values: [
            {
              value:
                'Лид из бота\nutm_source: inst\nutm_medium: social\nutm_content: link_in_bio',
            },
          ],
        },
      ],
    };
    expect(extractUtm(raw)).toEqual({
      source: 'inst',
      medium: 'social',
      campaign: null,
      content: 'link_in_bio',
      term: null,
    });
  });

  it('возвращает all-null если UTM нигде нет', () => {
    expect(extractUtm({ custom_fields_values: [] })).toEqual({
      source: null,
      medium: null,
      campaign: null,
      content: null,
      term: null,
    });
  });

  it('устойчив к null/undefined raw', () => {
    expect(extractUtm(null)).toEqual({
      source: null,
      medium: null,
      campaign: null,
      content: null,
      term: null,
    });
  });

  it('не крашится на null-элементах внутри custom_fields_values', () => {
    const raw = {
      custom_fields_values: [
        null,
        { field_name: 'utm_source', values: [{ value: 'yandex' }] },
        undefined,
      ],
    };
    expect(extractUtm(raw)).toEqual({
      source: 'yandex',
      medium: null,
      campaign: null,
      content: null,
      term: null,
    });
  });

  it('корректно парсит query-string формат в комментарии (не жадный regex)', () => {
    const raw = {
      custom_fields_values: [
        {
          field_name: 'Комментарий',
          values: [
            { value: 'utm_source=yandex&utm_medium=cpc&utm_campaign=summer2026' },
          ],
        },
      ],
    };
    expect(extractUtm(raw)).toEqual({
      source: 'yandex',
      medium: 'cpc',
      campaign: 'summer2026',
      content: null,
      term: null,
    });
  });

  it('добирает недостающие UTM из комментария, если Pass 1 нашёл только часть', () => {
    const raw = {
      custom_fields_values: [
        { field_name: 'utm_source', values: [{ value: 'yandex' }] },
        {
          field_name: 'Комментарий',
          values: [{ value: 'utm_medium: cpc\nutm_campaign: 123' }],
        },
      ],
    };
    expect(extractUtm(raw)).toEqual({
      source: 'yandex',
      medium: 'cpc',
      campaign: '123',
      content: null,
      term: null,
    });
  });
});
