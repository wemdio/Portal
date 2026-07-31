import {
  decideEditorExit,
  EDITOR_EXIT_MESSAGE,
  type EditorExitIntent,
} from '@/lib/hypothesisEngine/editorDirtyGuard';

const INTENTS: EditorExitIntent[] = ['switchLetter', 'swapVariant', 'regenerate', 'leaveStep'];

describe('decideEditorExit', () => {
  it('без несохранённых правок — ничего не спрашивает и не чистит (все интенты)', () => {
    for (const intent of INTENTS) {
      expect(decideEditorExit(intent, false)).toEqual({ confirm: false, clear: false });
    }
  });

  it('переключение письма (dirty): спросить и очистить (редактор заменяется другим письмом)', () => {
    expect(decideEditorExit('switchLetter', true)).toEqual({ confirm: true, clear: true });
  });

  it('A/B-действие (dirty): спросить и очистить (варианты/показ писем меняются)', () => {
    expect(decideEditorExit('swapVariant', true)).toEqual({ confirm: true, clear: true });
  });

  it('перегенерация цепочки (dirty): спросить и очистить (письма будут заменены целиком)', () => {
    expect(decideEditorExit('regenerate', true)).toEqual({ confirm: true, clear: true });
  });

  it('уход со шага (dirty): спросить и очистить (в отличие от v2 — не тихий сброс)', () => {
    expect(decideEditorExit('leaveStep', true)).toEqual({ confirm: true, clear: true });
  });

  it('все интенты при dirty единообразны: confirm + clear (единый диалог «отменить правки?»)', () => {
    for (const intent of INTENTS) {
      expect(decideEditorExit(intent, true)).toEqual({ confirm: true, clear: true });
    }
  });

  it('текст подтверждения — единый и непустой', () => {
    expect(EDITOR_EXIT_MESSAGE.trim().length).toBeGreaterThan(0);
  });

  it('покрывает ВСЕ интенты — при добавлении нового интента тест заставит определить политику', () => {
    // Явный список — новый EditorExitIntent без ветки в POLICY даст undefined
    // и уронит этот проход (заставит автора продумать confirm/clear).
    for (const intent of INTENTS) {
      const d = decideEditorExit(intent, true);
      expect(typeof d.confirm).toBe('boolean');
      expect(typeof d.clear).toBe('boolean');
    }
  });
});
