import { isRepeatOfOurs } from '@/lib/tgOutreach/replyGuards';
import type { DialogMessage } from '@/lib/tgOutreach/types';

const CLOSING = 'Хорошо. Если тема станет актуальной, можно будет вернуться к обсуждению.';

const history = (...msgs: Array<[DialogMessage['role'], string]>): DialogMessage[] =>
  msgs.map(([role, content]) => ({ role, content }));

describe('isRepeatOfOurs', () => {
  // Боевой случай: в тупике разговора модель слово в слово повторяет
  // собственную прощальную реплику. Для Telegram одинаковые сообщения — прямой
  // признак спам-рассылки.
  it('ловит дословный повтор нашей же реплики', () => {
    expect(isRepeatOfOurs(CLOSING, history(['assistant', CLOSING], ['user', 'Хорошо.']))).toBe(true);
  });

  it('регистр, пунктуация и ё на сравнение не влияют', () => {
    expect(isRepeatOfOurs('хорошо, вернемся!!!', history(['assistant', 'Хорошо, вернёмся.']))).toBe(true);
  });

  it('лишние пробелы и переносы тоже', () => {
    expect(isRepeatOfOurs('  Хорошо,\n  вернёмся. ', history(['assistant', 'Хорошо, вернёмся.']))).toBe(true);
  });

  it('повтор считается по всей истории, не только по последнему', () => {
    const h = history(['assistant', CLOSING], ['user', 'Ок'], ['assistant', 'Другое'], ['user', 'Ага']);
    expect(isRepeatOfOurs(CLOSING, h)).toBe(true);
  });

  // Совпадение с репликой СОБЕСЕДНИКА повтором не является: это нормальный
  // разговор, а не самоповтор рассылки.
  it('совпадение со словами собеседника повтором не считается', () => {
    expect(isRepeatOfOurs('Хорошо.', history(['user', 'Хорошо.']))).toBe(false);
  });

  it('новый текст пропускается', () => {
    expect(isRepeatOfOurs('Пришлю условия сегодня.', history(['assistant', CLOSING]))).toBe(false);
  });

  // Порогов подобия здесь намеренно нет: неверный порог глушил бы осмысленные
  // ответы. Тест фиксирует это как решение, а не как недосмотр.
  it('похожий, но не совпадающий ответ проходит', () => {
    expect(isRepeatOfOurs('Хорошо, вернёмся позже.', history(['assistant', 'Хорошо, вернёмся.']))).toBe(false);
  });

  it('пустой ответ повтором не считается — его отсеет другая проверка', () => {
    expect(isRepeatOfOurs('   ', history(['assistant', '   ']))).toBe(false);
  });

  it('пустая история не роняет проверку', () => {
    expect(isRepeatOfOurs('Привет', [])).toBe(false);
    expect(isRepeatOfOurs('Привет', undefined as unknown as DialogMessage[])).toBe(false);
  });
});
