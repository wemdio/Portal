import { detectStub, dropIfStub } from '@/lib/clientBrief/autofill/stubFilters';

describe('detectStub — generic patterns', () => {
  it.each([
    ["Раздел 'Кейсы' на сайте, упомянуто 85+ проектов", 'cases'],
    ["Раздел 'Отзывы' на сайте", 'recommendations'],
    ["Раздел 'СМИ о нас' на сайте", 'media'],
    ["Упоминание 'Член гильдии маркетологов'", 'awards'],
    ['Есть раздел кейсов на сайте', 'cases'],
    ['Имеются кейсы и портфолио', 'cases'],
    ['Кейсы есть в портфолио', 'cases'],
    ['85+ проектов', 'cases'],
    ['100 кейсов', 'cases'],
    ['Положительные отзывы на разных платформах', 'recommendations'],
    ['Много хороших отзывов', 'recommendations'],
    ['Множество наград', 'awards'],
    ['Подробнее на сайте', 'cases'],
    ['Смотрите в портфолио', 'cases'],
    ['Информация о наградах есть', 'awards'],
    ['На сайте представлены кейсы', 'cases'],
  ] as const)('ловит «%s» как stub (категория %s)', (text, category) => {
    const result = detectStub(text, category);
    expect(result.isStub).toBe(true);
  });
});

describe('detectStub — пустые/невалидные', () => {
  it('пустая строка → stub с reason=empty', () => {
    expect(detectStub('', 'cases')).toEqual({ isStub: true, reason: 'empty' });
  });
  it('только пробелы → stub', () => {
    expect(detectStub('   \n\t  ', 'cases').isStub).toBe(true);
  });
  it('не-строка → stub', () => {
    expect(detectStub(null, 'cases').isStub).toBe(true);
    expect(detectStub(undefined, 'cases').isStub).toBe(true);
    expect(detectStub(42, 'cases').isStub).toBe(true);
  });
});

describe('detectStub — category cases', () => {
  it('длинный текст с тире — не stub', () => {
    const text = 'ВкусВилл — настройка email-outreach по B2B-клиентам — 142 лида за квартал';
    expect(detectStub(text, 'cases').isStub).toBe(false);
  });
  it('короткий без тире и без цифр — stub (too_short_without_markers)', () => {
    expect(detectStub('Кратко о кейсах', 'cases').reason).toBe('too_short_without_markers');
  });
  it('короткий с цифрами/процентами — не stub', () => {
    expect(detectStub('Рост 42% за месяц', 'cases').isStub).toBe(false);
  });
});

describe('detectStub — category ratings', () => {
  it('"Положительные оценки" — generic stub', () => {
    expect(detectStub('Положительные оценки', 'ratings').reason).toBe('generic_pattern');
  });
  it('"Высокие оценки клиентов" — generic stub', () => {
    expect(detectStub('Высокие оценки клиентов', 'ratings').reason).toBe('generic_pattern');
  });
  it('"Хорошие рейтинги без чисел" — missing_required_marker', () => {
    expect(detectStub('Рейтинги от пользователей', 'ratings').reason).toBe('missing_required_marker');
  });
  it('с дробью — не stub', () => {
    expect(detectStub('Яндекс.Карты: 4.8/5 (124)', 'ratings').isStub).toBe(false);
  });
  it('с процентом — не stub', () => {
    expect(detectStub('NPS: 87%', 'ratings').isStub).toBe(false);
  });
  it('TOP-20 / 2025 (любая цифра) — не stub', () => {
    expect(detectStub('TOP-20 Tagline 2025', 'ratings').isStub).toBe(false);
  });
});

describe('detectStub — category recommendations', () => {
  it('без кавычек/имени — stub', () => {
    expect(detectStub('Клиенты довольны нашей работой каждый день', 'recommendations').reason).toBe(
      'missing_required_marker',
    );
  });
  it('с кавычками-ёлочками — не stub', () => {
    expect(detectStub('Иван: «Огонь»', 'recommendations').isStub).toBe(false);
  });
  it('с CEO/CMO — не stub', () => {
    expect(detectStub('Иван Петров, CMO: великолепный сервис', 'recommendations').isStub).toBe(false);
  });
});

describe('detectStub — category press', () => {
  it('без даты/года — stub', () => {
    expect(detectStub('VC.ru опубликовал статью', 'press').reason).toBe('missing_required_marker');
  });
  it('с годом — не stub', () => {
    expect(detectStub('VC.ru (2024): обзор', 'press').isStub).toBe(false);
  });
  it('с месяцем — не stub', () => {
    expect(detectStub('Forbes (декабрь): интервью', 'press').isStub).toBe(false);
  });
});

describe('detectStub — category awards', () => {
  it('с годом — не stub', () => {
    expect(detectStub('Tagline Awards 2024 — №1', 'awards').isStub).toBe(false);
  });
  it('без года, но с тире и длинный — не stub', () => {
    expect(detectStub('Сертификат партнёра Mailchimp Pro — официально подтверждённый статус', 'awards').isStub).toBe(false);
  });
  it('короткий без структуры — stub', () => {
    expect(detectStub('Есть награды', 'awards').reason).toBe('generic_pattern');
  });
});

describe('detectStub — category media', () => {
  it('с двоеточием — не stub', () => {
    expect(detectStub('YouTube (2024): подкаст про email', 'media').isStub).toBe(false);
  });
  it('"Есть видео на YouTube" — stub', () => {
    expect(detectStub('Есть видео на YouTube канале', 'media').reason).toBe('generic_pattern');
  });
});

describe('detectStub — category common_questions', () => {
  it('Q/A формат — не stub', () => {
    expect(detectStub('В: Сколько стоит?\nО: От 80к', 'common_questions').isStub).toBe(false);
  });
  it('2+ знака вопроса — не stub', () => {
    expect(detectStub('Сколько стоит? Когда первые лиды?', 'common_questions').isStub).toBe(false);
  });
  it('без вопросов — stub', () => {
    expect(detectStub('Описание услуг', 'common_questions').reason).toBe('missing_required_marker');
  });
});

describe('detectStub — category client_problems', () => {
  it('длинный текст — не stub', () => {
    expect(detectStub('Клиенты обожглись на холодных рассылках и боятся повторного провала', 'client_problems').isStub).toBe(false);
  });
  it('короткий — stub', () => {
    expect(detectStub('Разные проблемы', 'client_problems').isStub).toBe(true);
  });
});

describe('dropIfStub', () => {
  it('возвращает оригинал если не stub', () => {
    expect(dropIfStub('ВкусВилл — email-outreach — 142 лида', 'cases')).toBe(
      'ВкусВилл — email-outreach — 142 лида',
    );
  });
  it('возвращает пустую строку если stub', () => {
    expect(dropIfStub("Раздел 'Кейсы' на сайте", 'cases')).toBe('');
  });
  it('пустая строка → пустая строка', () => {
    expect(dropIfStub('', 'cases')).toBe('');
  });
});
