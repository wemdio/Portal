import {
  decideLetterExit,
  LETTER_EXIT_MESSAGE,
  type LetterExitIntent,
} from '@/lib/emailSequenceV2/letterDirtyGuard';

const INTENTS: LetterExitIntent[] = ['switchLetter', 'addLetter', 'sendToLaunch', 'leaveStep'];

describe('decideLetterExit', () => {
  it('без несохранённых правок — ничего не спрашивает и не чистит (все интенты)', () => {
    for (const intent of INTENTS) {
      expect(decideLetterExit(intent, false)).toEqual({ confirm: false, clear: false });
    }
  });

  it('переключение письма (dirty): спросить и очистить (редактор заменяется, reload не следует)', () => {
    expect(decideLetterExit('switchLetter', true)).toEqual({ confirm: true, clear: true });
  });

  it('добавление письма (dirty): спросить, но НЕ чистить здесь (loadRun перезагрузит и очистит)', () => {
    expect(decideLetterExit('addLetter', true)).toEqual({ confirm: true, clear: false });
  });

  it('отправка в рассылку (dirty): спросить, но НЕ чистить (редактор остаётся, флаг нужен для след. действий)', () => {
    expect(decideLetterExit('sendToLaunch', true)).toEqual({ confirm: true, clear: false });
  });

  it('уход со шага «Письма» (dirty): не спрашивать, тихо очистить (контракт «Назад»)', () => {
    expect(decideLetterExit('leaveStep', true)).toEqual({ confirm: false, clear: true });
  });

  it('интенты выхода, которые РЕАЛЬНО убирают открытый редактор, чистят реестр (switch/leave)', () => {
    // switch заменяет письмо, leave размонтирует редактор — оба должны сбросить флаг,
    // иначе он протухнет и даст ложное предупреждение; add/send оставляют состояние.
    expect(decideLetterExit('switchLetter', true).clear).toBe(true);
    expect(decideLetterExit('leaveStep', true).clear).toBe(true);
    expect(decideLetterExit('addLetter', true).clear).toBe(false);
    expect(decideLetterExit('sendToLaunch', true).clear).toBe(false);
  });

  it('sendToLaunch — единственный «критичный» выход: спрашивает, но флаг сохраняет', () => {
    const d = decideLetterExit('sendToLaunch', true);
    expect(d.confirm).toBe(true);
    expect(d.clear).toBe(false);
  });

  it('у каждого confirm-интента непустой текст диалога; у leaveStep — пустой', () => {
    for (const intent of INTENTS) {
      if (decideLetterExit(intent, true).confirm) {
        expect(LETTER_EXIT_MESSAGE[intent].trim().length).toBeGreaterThan(0);
      }
    }
    expect(LETTER_EXIT_MESSAGE.leaveStep).toBe('');
  });

  it('покрывает ВСЕ интенты — при добавлении нового интента тест заставит определить политику', () => {
    // Явный список — новый LetterExitIntent без ветки в POLICY даст undefined
    // и уронит этот проход (заставит автора продумать confirm/clear).
    for (const intent of INTENTS) {
      const d = decideLetterExit(intent, true);
      expect(typeof d.confirm).toBe('boolean');
      expect(typeof d.clear).toBe('boolean');
      expect(typeof LETTER_EXIT_MESSAGE[intent]).toBe('string');
    }
  });
});
