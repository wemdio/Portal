import {
  parseReviewsResponse,
  reviewsPatchToBriefPatch,
} from '@/lib/clientBrief/autofill/enrichers/reviews';

describe('parseReviewsResponse', () => {
  it('парсит валидный JSON с числовыми рейтингами и цитатами', () => {
    const raw = JSON.stringify({
      ratings_comment: 'Яндекс.Карты: 4.8/5 (124 отзыва)\nGoogle Maps: 4.9/5',
      recommendations_comment:
        'Иван Петров, директор по маркетингу: «Лиды выросли в 2.5 раза»\nМария Смирнова, CEO: «Прозрачная отчётность»',
    });
    const patch = parseReviewsResponse(raw);
    expect(patch.ratings_comment).toContain('4.8/5');
    expect(patch.recommendations_comment).toContain('Иван Петров');
  });

  it('пропускает рейтинг без чисел как отписку', () => {
    const raw = JSON.stringify({
      ratings_comment: 'Положительные отзывы на разных платформах',
    });
    expect(parseReviewsResponse(raw).ratings_comment).toBeUndefined();
  });

  it('пропускает рейтинг с stub-фразой даже если есть случайные цифры', () => {
    const raw = JSON.stringify({
      ratings_comment: 'Положительные отзывы на сайте 2024 года',
    });
    expect(parseReviewsResponse(raw).ratings_comment).toBeUndefined();
  });

  it('принимает рейтинг в формате X/Y', () => {
    const raw = JSON.stringify({ ratings_comment: 'VC.ru: 8.5/10' });
    expect(parseReviewsResponse(raw).ratings_comment).toBe('VC.ru: 8.5/10');
  });

  it('принимает рейтинг в процентах', () => {
    const raw = JSON.stringify({ ratings_comment: 'NPS: 87%' });
    expect(parseReviewsResponse(raw).ratings_comment).toBe('NPS: 87%');
  });

  it('пропускает рекомендацию без цитаты/имени как отписку', () => {
    const raw = JSON.stringify({
      recommendations_comment: 'Много положительных отзывов от клиентов',
    });
    expect(parseReviewsResponse(raw).recommendations_comment).toBeUndefined();
  });

  it('принимает рекомендацию с кавычками-ёлочками', () => {
    const raw = JSON.stringify({
      recommendations_comment: 'Анна, CEO: «Отличный сервис»',
    });
    expect(parseReviewsResponse(raw).recommendations_comment).toContain('Анна');
  });

  it('принимает рекомендацию с двойными кавычками', () => {
    const raw = JSON.stringify({
      recommendations_comment: 'Pete, CTO: "Saved us 6 months"',
    });
    expect(parseReviewsResponse(raw).recommendations_comment).toContain('Pete');
  });

  it('возвращает пустой объект на невалидном JSON', () => {
    expect(parseReviewsResponse('not json')).toEqual({});
    expect(parseReviewsResponse(null)).toEqual({});
  });

  it('обрабатывает не-строки в полях', () => {
    const raw = JSON.stringify({
      ratings_comment: 123,
      recommendations_comment: ['x'],
    });
    expect(parseReviewsResponse(raw)).toEqual({});
  });
});

describe('reviewsPatchToBriefPatch', () => {
  it('заворачивает ratings_comment в social_proof.ratings', () => {
    const briefPatch = reviewsPatchToBriefPatch({ ratings_comment: '4.8/5' });
    const sp = briefPatch.social_proof as { ratings?: { has: boolean; comment: string } };
    expect(sp.ratings?.has).toBe(true);
    expect(sp.ratings?.comment).toBe('4.8/5');
  });

  it('заворачивает recommendations_comment в social_proof.recommendations', () => {
    const briefPatch = reviewsPatchToBriefPatch({
      recommendations_comment: 'Иван: «Огонь»',
    });
    const sp = briefPatch.social_proof as {
      recommendations?: { has: boolean; comment: string };
    };
    expect(sp.recommendations?.has).toBe(true);
  });

  it('возвращает пустой patch если оба поля пусты', () => {
    expect(reviewsPatchToBriefPatch({})).toEqual({});
  });

  it('заполняет оба ключа social_proof если оба заполнены', () => {
    const briefPatch = reviewsPatchToBriefPatch({
      ratings_comment: '4.8/5',
      recommendations_comment: 'Имя: «цитата»',
    });
    const sp = briefPatch.social_proof as Record<string, unknown>;
    expect(Object.keys(sp)).toEqual(expect.arrayContaining(['ratings', 'recommendations']));
  });
});
