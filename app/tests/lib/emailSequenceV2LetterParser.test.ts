/** @jest-environment node */

jest.mock('server-only', () => ({}));

import { parseLettersFromModelOutput } from '@/lib/emailSequenceV2/letterParser';

describe('emailSequenceV2 letterParser', () => {
  it('returns [] for empty/whitespace input', () => {
    expect(parseLettersFromModelOutput('')).toEqual([]);
    expect(parseLettersFromModelOutput('   \n\n   ')).toEqual([]);
  });

  it('parses 5 letters using ---LETTER N--- markers', () => {
    const raw = `---LETTER 1---
Тема: Контакт CFO
Здравствуйте! Текст письма 1.

---LETTER 2---
Тема: Кратко о нас
Текст письма 2 строка 1.
Текст письма 2 строка 2.

---LETTER 3---
Тема: Снимаем возражения
Тело третьего письма.

---LETTER 4---
Тема: Финал
Финальное письмо.

---LETTER 5---
Тема: Бонус
Дополнительное письмо.`;
    const letters = parseLettersFromModelOutput(raw);
    expect(letters).toHaveLength(5);
    expect(letters.map((l) => l.letter_index)).toEqual([1, 2, 3, 4, 5]);
    expect(letters[0].subject).toBe('Контакт CFO');
    expect(letters[0].body).toContain('Здравствуйте! Текст письма 1.');
    expect(letters[1].body).toContain('Текст письма 2 строка 1.');
    expect(letters[1].body).toContain('Текст письма 2 строка 2.');
  });

  it('strips marker even when there is no leading newline', () => {
    const raw = '---LETTER 1---Тема: A\nТекст 1\n---LETTER 2---Тема: B\nТекст 2';
    const letters = parseLettersFromModelOutput(raw);
    expect(letters).toHaveLength(2);
    expect(letters[0].subject).toBe('A');
    expect(letters[1].subject).toBe('B');
  });

  it('reindexes sequentially after dedup', () => {
    const raw = `---LETTER 1---
Тема: a
b1
---LETTER 1---
Тема: dup
dup body
---LETTER 3---
Тема: c
b3
---LETTER 5---
Тема: d
b5`;
    const letters = parseLettersFromModelOutput(raw);
    expect(letters).toHaveLength(3);
    expect(letters.map((l) => l.letter_index)).toEqual([1, 2, 3]);
    expect(letters[0].subject).toBe('a');
    expect(letters[1].subject).toBe('c');
    expect(letters[2].subject).toBe('d');
  });

  it('falls back to splitting on Тема: when no markers', () => {
    const raw = `Тема: первое
тело 1 строка 1
тело 1 строка 2

Тема: второе
тело 2

Тема: третье
тело 3`;
    const letters = parseLettersFromModelOutput(raw);
    expect(letters).toHaveLength(3);
    expect(letters[0].subject).toBe('первое');
    expect(letters[1].subject).toBe('второе');
    expect(letters[2].subject).toBe('третье');
    expect(letters[0].body).toContain('тело 1 строка 1');
    expect(letters[0].body).toContain('тело 1 строка 2');
  });

  it('returns subject=null when first line is not "Тема: ..."', () => {
    const raw = `---LETTER 1---
Привет, Иван!
Это просто текст без темы.`;
    const letters = parseLettersFromModelOutput(raw);
    expect(letters).toHaveLength(1);
    expect(letters[0].subject).toBeNull();
    expect(letters[0].body).toContain('Привет, Иван!');
    expect(letters[0].body).toContain('Это просто текст без темы.');
  });

  it('handles 6 letters as upper bound', () => {
    const raw = Array.from({ length: 6 }, (_, i) => `---LETTER ${i + 1}---\nТема: T${i + 1}\nbody ${i + 1}`).join('\n');
    const letters = parseLettersFromModelOutput(raw);
    expect(letters).toHaveLength(6);
    expect(letters[5].subject).toBe('T6');
  });
});
