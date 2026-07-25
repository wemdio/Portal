/** @jest-environment node */

import { parseLettersFromModelOutput } from '@/lib/emailSequenceV2/letterParser';
import { parsedToChainLetters, CHAIN_WAIT_DAYS } from '@/lib/hypothesisEngine/stages/chain';

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

  it('RU-цепочка из 3 писем парсится в HeChainLetter с wait_days 0/2/3', () => {
    const parsed = parseLettersFromModelOutput(sampleRu);
    expect(parsed).toHaveLength(3);

    const letters = parsedToChainLetters(parsed);
    expect(letters).toHaveLength(3);
    expect(letters.map((l) => l.wait_days)).toEqual([0, 2, 3]);
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
    expect(letters.map((l) => l.wait_days)).toEqual([0, 2, 3]);
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
