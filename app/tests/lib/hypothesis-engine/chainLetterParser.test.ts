/** @jest-environment node */

import { parseLettersFromModelOutput } from '@/lib/emailSequenceV2/letterParser';
import {
  buildChainLetters,
  extractLetterBVariants,
  parsedToChainLetters,
  CHAIN_WAIT_DAYS,
} from '@/lib/hypothesisEngine/stages/chain';

/**
 * Интеграция: ответ модели в формате, который требуют промпты стадий
 * chain/template (---LETTER N--- + локализованная тема) → letterParser →
 * HeChainLetter[] с лесенкой wait_days. Это ровно тот путь, по которому
 * письма попадают в he_chains / he_templates.
 */
describe('chain letterParser integration', () => {
  const sampleRu = `---LETTER 1---
Тема: Платёжный стек под iGaming

Здравствуйте! Видим, что у операторов вашего профиля болит эквайринг.
Мы поднимали конверсию платежей подобным командам.

---LETTER 2---
Тема: Короткий кейс

Один из ваших коллег по вертикали закрывал ту же дыру.
Могу прислать разбор, если тема живая.

---LETTER 3---
Тема: К кому обратиться?

Подскажите, кто у вас смотрит в сторону платёжной инфраструктуры?`;

  it('RU-цепочка из 3 писем парсится в HeChainLetter с wait_days 0/3/7', () => {
    const parsed = parseLettersFromModelOutput(sampleRu);
    expect(parsed).toHaveLength(3);

    const letters = parsedToChainLetters(parsed);
    expect(letters).toHaveLength(3);
    expect(letters.map((l) => l.wait_days)).toEqual([0, 3, 7]);
    expect(letters[0].subject).toBe('Платёжный стек под iGaming');
    expect(letters[0].body).toContain('болит эквайринг');
    expect(letters[2].subject).toBe('К кому обратиться?');
  });

  it('EN-вариант (Subject:) тоже проходит по тому же конвейеру', () => {
    const sampleEn = `---LETTER 1---
Subject: Payment stack for iGaming

Body one.

---LETTER 2---
Subject: Quick case

Body two.

---LETTER 3---
Subject: Who to talk to?

Body three.`;
    const letters = parsedToChainLetters(parseLettersFromModelOutput(sampleEn));
    expect(letters).toHaveLength(3);
    expect(letters[0].subject).toBe('Payment stack for iGaming');
    expect(letters.map((l) => l.wait_days)).toEqual([0, 3, 7]);
  });

  it('wait_days не выходит за пределы лесенки при 6 письмах', () => {
    const raw = Array.from({ length: 6 }, (_, i) => `---LETTER ${i + 1}---\nТема: T${i + 1}\nbody ${i + 1}`).join('\n');
    const letters = parsedToChainLetters(parseLettersFromModelOutput(raw));
    expect(letters).toHaveLength(6);
    expect(letters[5].wait_days).toBe(CHAIN_WAIT_DAYS[CHAIN_WAIT_DAYS.length - 1]);
  });

  it('порог стадии: меньше 3 писем в ответе → parser возвращает <3 (стадия уходит в retry)', () => {
    const raw = `---LETTER 1---\nТема: Одно\nbody\n---LETTER 2---\nТема: Два\nbody`;
    expect(parseLettersFromModelOutput(raw)).toHaveLength(2);
  });
});

/**
 * A/B-варианты (---LETTER N B---): пост-сплиттер stages/chain вырезает
 * B-блоки ДО letterParser (общий с emailSequenceV2, не меняется), основной
 * вариант A парсится как раньше, B попадает в letters[].variants как
 * {subject, body}.
 */
describe('extractLetterBVariants (A/B, ---LETTER N B---)', () => {
  const sampleWithB = `---LETTER 1---
Тема: Повод от получателя

Тело A первого письма.

---LETTER 1 B---
Тема: Повод от рынка

Тело B первого письма — другой угол.

---LETTER 2---
Тема: Второе письмо

Тело A второго письма.

---LETTER 2 B---
Тема: Второе письмо, вариант B

Тело B второго письма.

---LETTER 3---
Тема: Третье письмо

Тело A третьего письма.`;

  it('B-блоки вырезаются из основного текста и парсятся отдельно', () => {
    const { cleaned, variants } = extractLetterBVariants(sampleWithB);
    expect(cleaned).not.toContain('LETTER 1 B');
    expect(cleaned).not.toContain('другой угол');

    const parsed = parseLettersFromModelOutput(cleaned);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].subject).toBe('Повод от получателя');
    expect(parsed[0].body).toBe('Тело A первого письма.');
    expect(parsed[0].body).not.toContain('Тело B');

    expect(variants.get(1)).toEqual({
      subject: 'Повод от рынка',
      body: 'Тело B первого письма — другой угол.',
    });
    expect(variants.get(2)).toEqual({
      subject: 'Второе письмо, вариант B',
      body: 'Тело B второго письма.',
    });
    expect(variants.has(3)).toBe(false);
  });

  it('buildChainLetters: вариант B приклеивается к письму, лесенка wait_days не ломается', () => {
    const { parsed, letters } = buildChainLetters(sampleWithB);
    expect(parsed).toHaveLength(3);
    expect(letters.map((l) => l.wait_days)).toEqual([0, 3, 7]);
    expect(letters[0].subject).toBe('Повод от получателя');
    expect(letters[0].body).toBe('Тело A первого письма.');
    expect(letters[0].variants).toEqual([
      { subject: 'Повод от рынка', body: 'Тело B первого письма — другой угол.' },
    ]);
    expect(letters[1].variants).toHaveLength(1);
    expect(letters[2].variants).toBeUndefined();
  });

  it('EN: тема варианта парсится локализованным словом (Subject:)', () => {
    const en = `---LETTER 1---
Subject: Main angle

Body A.

---LETTER 1 B---
Subject: Market angle

Body B.`;
    const { variants } = extractLetterBVariants(en);
    expect(variants.get(1)).toEqual({ subject: 'Market angle', body: 'Body B.' });
  });

  it('текст без B-маркеров возвращается как есть', () => {
    const plain = `---LETTER 1---\nТема: Раз\n\nТело.\n\n---LETTER 2---\nТема: Два\n\nТело 2.`;
    const { cleaned, variants } = extractLetterBVariants(plain);
    expect(cleaned).toBe(plain);
    expect(variants.size).toBe(0);
  });

  it('B для несуществующего письма отбрасывается', () => {
    const raw = `${sampleWithB}\n\n---LETTER 9 B---\nТема: Лишний\n\nНет такого письма.`;
    const { variants } = extractLetterBVariants(raw);
    expect(variants.size).toBe(2);
    expect(variants.has(9)).toBe(false);
  });

  it('B-блок обрывается на следующем маркере и не захватывает чужие блоки', () => {
    const raw = `---LETTER 1---
Тема: Основное

Тело A.

---LETTER 1 B---
Тема: Альт

Тело B.

---LETTER 2---
Тема: Второе

Тело 2.`;
    const { variants } = extractLetterBVariants(raw);
    expect(variants.get(1)?.body).toBe('Тело B.');
    expect(variants.get(1)?.body).not.toContain('Тело 2');
  });

  it('дубль B для того же письма: берётся первый, второй вырезается из текста', () => {
    const raw = `---LETTER 1---
Тема: Основное

Тело A.

---LETTER 1 B---
Тема: Первый B

Тело B1.

---LETTER 1 B---
Тема: Второй B

Тело B2.`;
    const { cleaned, variants } = extractLetterBVariants(raw);
    expect(variants.size).toBe(1);
    expect(variants.get(1)?.subject).toBe('Первый B');
    expect(cleaned).not.toContain('Тело B2');
  });
});
