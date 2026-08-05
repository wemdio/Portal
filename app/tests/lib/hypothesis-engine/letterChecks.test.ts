/**
 * Tests for lib/hypothesisEngine/letterChecks — детерминированный контроль
 * писем: тире, приветствие, один CTA, стоп-фразы, фактчек цифр по материалам.
 */

import {
  checkLetterRules,
  extractNumberFacts,
  findUnverifiedNumbers,
} from '@/lib/hypothesisEngine/letterChecks';

const GOOD_BODY = `Здравствуйте, {{firstName}}!

Видел цифру по вашей отрасли: доля сделок, застрявших на пилоте, выросла в 1,7 раза.

Мы делаем email-аутрич под ключ: находим компании и приводим их на разговор с ЛПР.

Это актуально вам, или подскажете, кто отвечает за новых клиентов?

Сергей, Polza`;

describe('checkLetterRules — clean letter passes', () => {
  it('no violations for a well-formed letter with a corpus-backed number', () => {
    const facts = extractNumberFacts('Доля сделок выросла в 1,7 раза, рынок +12%.');
    const v = checkLetterRules([{ subject: '{{company}} и аутрич', body: GOOD_BODY }], 'ru', facts);
    expect(v).toEqual([]);
  });
});

describe('checkLetterRules — rule violations', () => {
  it('flags em/en dashes in subject and body', () => {
    const v = checkLetterRules(
      [{ subject: 'Аутрич — под ключ', body: GOOD_BODY }],
      'ru',
      new Set(),
    );
    expect(v.some((x) => x.rule === 'dash')).toBe(true);
  });

  it('flags missing greeting', () => {
    const v = checkLetterRules(
      [{ subject: 'Тема', body: 'Ваш рынок упирается в потолок. Вопрос?\n\nКоманда' }],
      'ru',
      new Set(),
    );
    expect(v.some((x) => x.rule === 'greeting')).toBe(true);
  });

  it('flags zero or multiple CTA question marks', () => {
    const zero = checkLetterRules([{ subject: 't', body: GOOD_BODY.replace('Это актуально вам, или подскажете, кто отвечает за новых клиентов?', 'Напишите нам.') }], 'ru', new Set());
    expect(zero.some((x) => x.rule === 'cta')).toBe(true);

    const two = checkLetterRules(
      [{ subject: 't', body: GOOD_BODY + '\n\nУдобно созвониться?' }],
      'ru',
      new Set(),
    );
    expect(two.some((x) => x.rule === 'cta' && x.detail.includes('2'))).toBe(true);
  });

  it('flags stop phrases and clichés only for ru', () => {
    const body = `Здравствуйте!\n\nМы — команда профессионалов, гарантируем поток заявок. Поговорим?\n\nКоманда`;
    const ru = checkLetterRules([{ subject: 't', body }], 'ru', new Set());
    expect(ru.filter((x) => x.rule === 'stop_phrase').length).toBeGreaterThanOrEqual(3);

    const en = checkLetterRules([{ subject: 't', body }], 'en', new Set());
    expect(en.filter((x) => x.rule === 'stop_phrase')).toEqual([]);
  });
});

describe('numbers fact-check', () => {
  const facts = extractNumberFacts('Рынок вырос на 12%, доля пилотов в 1,7 раза, 680 клиентов, n=531.');

  it('accepts numbers present in the corpus (incl. int variant of decimal)', () => {
    expect(findUnverifiedNumbers('Рост 12% и 680 клиентов, 1,7 раза.', facts)).toEqual([]);
  });

  it('flags hallucinated stats but ignores small structural numbers', () => {
    const bad = findUnverifiedNumbers('Рост 47% за квартал; тест 2 недели, 3–5 встреч.', facts);
    expect(bad).toEqual(['47%']);
  });

  it('normalizes comma decimals and percent/space forms', () => {
    expect(findUnverifiedNumbers('выросла в 1.7 раза и +12 %', facts)).toEqual([]);
  });
});
