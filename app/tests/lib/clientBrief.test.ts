import {
  compileBriefText,
  validateBriefInput,
  normalizeBriefFields,
  EMPTY_BRIEF_FIELDS,
  SOCIAL_PROOF_KEYS,
} from '@/lib/clientBrief';
import type { ClientBriefFields } from '@/lib/clientBrief';

const fullBrief: ClientBriefFields = {
  company_website: 'redev.ru',
  company_description: 'Группа компаний .redev — технологический партнёр для бизнеса.',
  company_contacts: '8-926-698-55-99',
  deal_cycle: '6-10 мес',
  avg_check: '6-8 млн ₽',

  product_description: 'Аутсорс, заказная разработка, отраслевые решения, консалтинг.',
  price_tier: 'business',
  advantages: 'Экспертиза в e-commerce и логистике\nПартнёрский, а не подрядный подход',
  usp: 'Архитектор технологических изменений',
  competitors_problems: 'Не понимают отрасль; срывают сроки',
  impressive_numbers: '5+ лет, ТОП-20 Tagline 2025',
  special_offer: '-',

  target_audience: 'Сегмент: e-commerce — CIO, Digital-директор. Сегмент: логистика — директор по логистике.',
  client_problems: 'Разрозненные системы; legacy-инфраструктура',
  common_questions: 'Какие сроки? Чем отличаетесь от других?',

  persona_name: 'Александр Тычков',
  persona_position: 'Директор по развитию бизнеса (CBDO)',
  lead_recipient_name: 'Александр Тычков',
  lead_recipient_email: 'a.tychkov@redev.ru',
  lead_recipient_position: 'CBDO',
  lead_magnets: 'Бесплатный pre-sale',
  guarantees: '-',

  existing_clients: '36.6, ГорЗдрав, Инвитро, Магнит, ВкусВилл, X5 Group',
  impressive_results: 'Платформа для аптечной сети 36.6 — bronze Tagline AWARDS 2025',

  social_proof: {
    ratings: { has: true, comment: 'TOP-20 Tagline 2025' },
    media: { has: true, comment: 'Подкасты GP Days, Softorium' },
    photos: { has: true, comment: '' },
    recommendations: { has: true, comment: 'Есть, нужно собирать' },
    cases: { has: true, comment: '' },
    awards: { has: true, comment: 'Tagline 2025 bronze' },
    press: { has: true, comment: 'РБК, CNews, Коммерсантъ' },
    presentations: { has: true, comment: '' },
  },

  additional_notes: 'Скину презентации с кейсами, там много результатов.',
};

describe('SOCIAL_PROOF_KEYS', () => {
  it('contains all 8 social proof categories from the agency template', () => {
    expect(SOCIAL_PROOF_KEYS).toEqual([
      'ratings',
      'media',
      'photos',
      'recommendations',
      'cases',
      'awards',
      'press',
      'presentations',
    ]);
  });
});

describe('EMPTY_BRIEF_FIELDS', () => {
  it('is a fully empty brief shape (every text field empty, every social_proof.has=false)', () => {
    expect(EMPTY_BRIEF_FIELDS.company_website).toBe('');
    expect(EMPTY_BRIEF_FIELDS.product_description).toBe('');
    expect(EMPTY_BRIEF_FIELDS.price_tier).toBeNull();
    for (const key of SOCIAL_PROOF_KEYS) {
      expect(EMPTY_BRIEF_FIELDS.social_proof[key]).toEqual({ has: false, comment: '' });
    }
  });
});

describe('normalizeBriefFields', () => {
  it('fills missing fields with empty defaults from EMPTY_BRIEF_FIELDS', () => {
    const partial = { company_website: 'acme.com' };
    const normalized = normalizeBriefFields(partial as Partial<ClientBriefFields>);
    expect(normalized.company_website).toBe('acme.com');
    expect(normalized.product_description).toBe('');
    expect(normalized.price_tier).toBeNull();
    expect(normalized.social_proof.ratings).toEqual({ has: false, comment: '' });
  });

  it('trims whitespace from text fields and normalizes line endings to \\n', () => {
    const partial: Partial<ClientBriefFields> = {
      company_description: '  Hello world  \r\nNext line  ',
      advantages: '\r\n  Item 1\r\n  Item 2  \r\n',
    };
    const normalized = normalizeBriefFields(partial);
    expect(normalized.company_description).toBe('Hello world\nNext line');
    expect(normalized.advantages).toBe('Item 1\n  Item 2');
  });

  it('normalizes price_tier: only allowed values are kept, otherwise null', () => {
    expect(normalizeBriefFields({ price_tier: 'business' }).price_tier).toBe('business');
    expect(normalizeBriefFields({ price_tier: 'economy' }).price_tier).toBe('economy');
    expect(normalizeBriefFields({ price_tier: 'middle' }).price_tier).toBe('middle');
    expect(normalizeBriefFields({ price_tier: 'premium' }).price_tier).toBe('premium');
    expect(normalizeBriefFields({ price_tier: 'invalid' as unknown as ClientBriefFields['price_tier'] }).price_tier).toBeNull();
    expect(normalizeBriefFields({}).price_tier).toBeNull();
  });

  it('coerces non-string text fields to empty string', () => {
    const dirty = {
      company_website: 123 as unknown as string,
      company_description: null as unknown as string,
      advantages: undefined as unknown as string,
    };
    const normalized = normalizeBriefFields(dirty as Partial<ClientBriefFields>);
    expect(normalized.company_website).toBe('');
    expect(normalized.company_description).toBe('');
    expect(normalized.advantages).toBe('');
  });

  it('keeps social_proof comments as strings and has-flags as booleans', () => {
    // Specifically tests dirty input: 'yes' string, numeric comment, missing keys.
    const dirty = {
      social_proof: {
        ratings: { has: true, comment: '  Some text  ' },
        media: { has: 'yes', comment: 42 },
        photos: undefined,
      },
    } as unknown as Partial<ClientBriefFields>;
    const normalized = normalizeBriefFields(dirty);
    expect(normalized.social_proof.ratings).toEqual({ has: true, comment: 'Some text' });
    expect(normalized.social_proof.media.has).toBe(true);
    expect(normalized.social_proof.media.comment).toBe('42');
    expect(normalized.social_proof.photos).toEqual({ has: false, comment: '' });
  });

  it('is idempotent: normalize(normalize(x)) === normalize(x)', () => {
    const once = normalizeBriefFields({ company_website: ' acme.com ' });
    const twice = normalizeBriefFields(once);
    expect(twice).toEqual(once);
  });
});

describe('validateBriefInput', () => {
  it('accepts a fully empty brief (всё опционально — клиент может сохранять черновик)', () => {
    expect(validateBriefInput(EMPTY_BRIEF_FIELDS)).toEqual({ ok: true });
  });

  it('accepts the full template-based brief', () => {
    expect(validateBriefInput(fullBrief)).toEqual({ ok: true });
  });

  it('rejects email in lead_recipient_email if it is not a valid email', () => {
    const bad = { ...EMPTY_BRIEF_FIELDS, lead_recipient_email: 'not-an-email' };
    const result = validateBriefInput(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/email/i);
  });

  it('accepts empty lead_recipient_email', () => {
    expect(validateBriefInput({ ...EMPTY_BRIEF_FIELDS, lead_recipient_email: '' })).toEqual({ ok: true });
  });

  it('rejects total payload size that exceeds the limit (200 000 chars)', () => {
    const huge = 'x'.repeat(200_001);
    const bad = { ...EMPTY_BRIEF_FIELDS, additional_notes: huge };
    const result = validateBriefInput(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/слишком|превыш|размер|лимит/i);
  });

  it('rejects company_website that is not http(s) URL or bare domain', () => {
    const bad = { ...EMPTY_BRIEF_FIELDS, company_website: 'mailto:foo@bar' };
    const result = validateBriefInput(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/сайт|website|url/i);
  });

  it('accepts plain domain as company_website (redev.ru)', () => {
    expect(validateBriefInput({ ...EMPTY_BRIEF_FIELDS, company_website: 'redev.ru' })).toEqual({ ok: true });
  });

  it('accepts https URL as company_website', () => {
    expect(validateBriefInput({ ...EMPTY_BRIEF_FIELDS, company_website: 'https://redev.ru/about' })).toEqual({ ok: true });
  });
});

describe('compileBriefText', () => {
  it('returns empty string for an empty brief (нечего скармливать AI)', () => {
    expect(compileBriefText(EMPTY_BRIEF_FIELDS)).toBe('');
  });

  it('returns markdown that includes every non-empty field labelled in Russian', () => {
    const text = compileBriefText(fullBrief);
    expect(text).toContain('# Бриф клиента');
    expect(text).toContain('## Компания');
    expect(text).toContain('redev.ru');
    expect(text).toContain('Группа компаний .redev');
    expect(text).toContain('## Продукт / услуга');
    expect(text).toContain('Бизнес-класс');
    expect(text).toContain('## Целевая аудитория');
    expect(text).toContain('Сегмент: e-commerce');
    expect(text).toContain('## Коммуникация');
    expect(text).toContain('Александр Тычков');
    expect(text).toContain('a.tychkov@redev.ru');
    expect(text).toContain('## Доказательства');
    expect(text).toContain('## Social proof');
    expect(text).toContain('TOP-20 Tagline 2025');
    expect(text).toContain('Скину презентации');
  });

  it('skips sections where ALL fields are empty (no empty headers in output)', () => {
    const onlyCompany: ClientBriefFields = {
      ...EMPTY_BRIEF_FIELDS,
      company_website: 'acme.com',
      company_description: 'A startup.',
    };
    const text = compileBriefText(onlyCompany);
    expect(text).toContain('## Компания');
    expect(text).not.toContain('## Продукт / услуга');
    expect(text).not.toContain('## Целевая аудитория');
    expect(text).not.toContain('## Коммуникация');
    expect(text).not.toContain('## Доказательства');
    expect(text).not.toContain('## Social proof');
  });

  it('translates price_tier code into the human Russian label', () => {
    expect(compileBriefText({ ...EMPTY_BRIEF_FIELDS, price_tier: 'economy' })).toContain('Эконом-класс');
    expect(compileBriefText({ ...EMPTY_BRIEF_FIELDS, price_tier: 'middle' })).toContain('Средний класс');
    expect(compileBriefText({ ...EMPTY_BRIEF_FIELDS, price_tier: 'business' })).toContain('Бизнес-класс');
    expect(compileBriefText({ ...EMPTY_BRIEF_FIELDS, price_tier: 'premium' })).toContain('Предмет роскоши');
  });

  it('lists only the social proof items where has=true and prints comments inline', () => {
    const partial: ClientBriefFields = {
      ...EMPTY_BRIEF_FIELDS,
      social_proof: {
        ...EMPTY_BRIEF_FIELDS.social_proof,
        ratings: { has: true, comment: 'Пять звёзд' },
        awards: { has: true, comment: '' },
        media: { has: false, comment: 'Игнорируется потому что has=false' },
      },
    };
    const text = compileBriefText(partial);
    expect(text).toContain('Рейтинги и отзывы: Пять звёзд');
    expect(text).toContain('Награды / сертификаты');
    expect(text).not.toContain('Игнорируется потому что has=false');
    expect(text).not.toContain('Видео / подкасты');
  });

  it('omits "Social proof" section entirely if no items are checked', () => {
    expect(compileBriefText({ ...EMPTY_BRIEF_FIELDS, additional_notes: 'x' })).not.toContain('## Social proof');
  });

  it('puts additional_notes under "Дополнительный контекст" heading', () => {
    const text = compileBriefText({ ...EMPTY_BRIEF_FIELDS, additional_notes: 'Доп инфа' });
    expect(text).toContain('## Дополнительный контекст');
    expect(text).toContain('Доп инфа');
  });

  it('does not duplicate the same value if both has=true and comment is set', () => {
    const partial: ClientBriefFields = {
      ...EMPTY_BRIEF_FIELDS,
      social_proof: {
        ...EMPTY_BRIEF_FIELDS.social_proof,
        ratings: { has: true, comment: 'TOP-20' },
      },
    };
    const text = compileBriefText(partial);
    const occurrences = text.split('TOP-20').length - 1;
    expect(occurrences).toBe(1);
  });
});
