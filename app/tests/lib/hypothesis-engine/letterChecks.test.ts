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

  it('uuid/timestamps in the corpus do not whitelist hallucinated numbers', () => {
    const dirty = extractNumberFacts(
      'Кейс id 019f7b03-2673-7841-a189-f30fa7007db1 создан 2024-05-12T10:20:30.123Z. Результат: 34 встречи.',
    );
    expect(findUnverifiedNumbers('12 клиентов и 30% роста', dirty)).toEqual(['12', '30%']);
    expect(findUnverifiedNumbers('34 встречи', dirty)).toEqual([]);
  });
});

describe('cliché boundaries (Cyrillic \\b workaround)', () => {
  it('flags «лидер/лучший/эффективный» in Russian text', () => {
    const body = 'Здравствуйте!\n\nМы лидеры рынка, самый лучший и эффективный подход. Поговорим?\n\nКоманда';
    const v = checkLetterRules([{ subject: 't', body }], 'ru', new Set());
    expect(v.filter((x) => x.rule === 'stop_phrase').length).toBeGreaterThanOrEqual(3);
  });

  it('does not misfire on lookalike substrings', () => {
    const body = 'Здравствуйте!\n\nНаша эффективность выросла, блок «Эффективность» внутри. Поговорим?\n\nКоманда';
    const v = checkLetterRules([{ subject: 't', body }], 'ru', new Set());
    expect(v.filter((x) => x.rule === 'stop_phrase')).toEqual([]);
  });
});

describe('EN tells (LLM-cliché detector, language=en)', () => {
  const CLEAN_EN = `Hi {{firstName}},

Your site gives each location its own page and phone number, which usually splits acquisition cost across clinics.

We run SEO and paid search for multi-location healthcare groups and tie spend to booked patients in the CRM.

Worth a look, or who owns patient growth on your side?

The WebFX team`;

  const check = (body: string) => checkLetterRules([{ subject: 't', body }], 'en', new Set());

  it('flags filler intensifiers (really/truly/actually/genuinely)', () => {
    for (const w of ['really', 'truly', 'actually', 'genuinely']) {
      const v = check(CLEAN_EN.replace('usually', w));
      expect(v.some((x) => x.rule === 'tell')).toBe(true);
    }
  });

  it('flags throat-clearing openers', () => {
    expect(check(CLEAN_EN.replace('Your site', 'I hope this email finds you well. Your site')).some((x) => x.rule === 'tell')).toBe(true);
    expect(check(CLEAN_EN.replace('Your site', "I hope you're doing well. Your site")).some((x) => x.rule === 'tell')).toBe(true);
  });

  it('flags the not-only/but-also construction', () => {
    const v = check(CLEAN_EN.replace('We run SEO and paid search for multi-location healthcare groups and tie spend to booked patients in the CRM.', 'We not only run SEO but also tie spend to booked patients.'));
    expect(v.some((x) => x.rule === 'tell')).toBe(true);
  });

  it('flags corporate-register words (leverage/underscore/seamless/delve)', () => {
    for (const w of ['leverage', 'underscore', 'seamless', 'delve into', 'unlock']) {
      const v = check(CLEAN_EN.replace('run SEO', `run SEO to ${w}`));
      expect(v.some((x) => x.rule === 'tell')).toBe(true);
    }
  });

  it('flags hedging fillers (just wanted to / just checking in / just reaching out)', () => {
    const v = check(CLEAN_EN.replace('Worth a look', 'Just wanted to ask: worth a look'));
    expect(v.some((x) => x.rule === 'tell')).toBe(true);
  });

  it('clean EN letter passes all rules', () => {
    expect(check(CLEAN_EN)).toEqual([]);
  });

  it('does not run tell rules for ru letters', () => {
    const v = checkLetterRules([{ subject: 't', body: GOOD_BODY }], 'ru', new Set());
    expect(v.some((x) => x.rule === 'tell')).toBe(false);
  });
});
