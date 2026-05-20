import {
  parsePressResponse,
  pressPatchToBriefPatch,
} from '@/lib/clientBrief/autofill/enrichers/press';

describe('parsePressResponse', () => {
  it('парсит валидный JSON со всеми тремя полями', () => {
    const raw = JSON.stringify({
      press_comment: 'VC.ru (март 2025): обзор кейса\nРБК (2024): интервью',
      awards_comment: '№1 в РФ по email-outreach 2024 — Tagline',
      media_comment: 'YouTube (2024): подкаст про автоматизацию',
    });
    const patch = parsePressResponse(raw);
    expect(patch.press_comment).toContain('VC.ru');
    expect(patch.awards_comment).toContain('Tagline');
    expect(patch.media_comment).toContain('YouTube');
  });

  it('фильтрует press без дат/годов', () => {
    const raw = JSON.stringify({
      press_comment: 'Упоминания в СМИ есть на разных платформах',
    });
    expect(parsePressResponse(raw).press_comment).toBeUndefined();
  });

  it('фильтрует press с stub-фразой даже если есть год', () => {
    const raw = JSON.stringify({
      press_comment: 'Пишут о нас много с 2020 года',
    });
    expect(parsePressResponse(raw).press_comment).toBeUndefined();
  });

  it('принимает press с месяцем без года', () => {
    const raw = JSON.stringify({
      press_comment: 'Forbes (декабрь): интервью основателя',
    });
    expect(parsePressResponse(raw).press_comment).toBeDefined();
  });

  it('принимает awards без года если есть тире/двоеточие', () => {
    const raw = JSON.stringify({
      awards_comment: 'Сертификат партнёра Mailchimp Pro — официально',
    });
    expect(parsePressResponse(raw).awards_comment).toContain('Mailchimp');
  });

  it('фильтрует awards вида "много наград"', () => {
    const raw = JSON.stringify({ awards_comment: 'Множество наград — рынка' });
    expect(parsePressResponse(raw).awards_comment).toBeUndefined();
  });

  it('фильтрует media вида "есть видео на YouTube"', () => {
    const raw = JSON.stringify({
      media_comment: 'Есть видео на YouTube канале компании',
    });
    expect(parsePressResponse(raw).media_comment).toBeUndefined();
  });

  it('возвращает пустой объект на невалидном JSON', () => {
    expect(parsePressResponse('garbage')).toEqual({});
  });

  it('обрабатывает не-строки', () => {
    expect(parsePressResponse(JSON.stringify({ press_comment: 42 }))).toEqual({});
  });
});

describe('pressPatchToBriefPatch', () => {
  it('заполняет три ключа social_proof', () => {
    const briefPatch = pressPatchToBriefPatch({
      press_comment: 'a',
      awards_comment: 'b',
      media_comment: 'c',
    });
    const sp = briefPatch.social_proof as Record<string, unknown>;
    expect(Object.keys(sp)).toEqual(expect.arrayContaining(['press', 'awards', 'media']));
  });

  it('возвращает пустой patch если все поля пусты', () => {
    expect(pressPatchToBriefPatch({})).toEqual({});
  });
});
