'use client';

import { useId } from 'react';
import { HE } from './design';

/** Project-level "addresses per company taken into work". Empty = no limit. */
export function parseContactLimitDraft(draft: string): { valid: boolean; value: number | null } {
  const text = draft.trim();
  if (!text) return { valid: true, value: null };
  if (!/^\d{1,3}$/.test(text)) return { valid: false, value: null };
  const value = Number(text);
  return value >= 1 && value <= 100 ? { valid: true, value } : { valid: false, value: null };
}

export function ContactLimitField({ value, draft, disabled, onDraftChange, onSave }: {
  value: number | null; draft: string; disabled: boolean;
  onDraftChange: (next: string) => void; onSave: (next: number | null) => void;
}) {
  const id = useId();
  const parsed = parseContactLimitDraft(draft);
  const changed = parsed.valid && parsed.value !== value;
  return (
    <div className="ve2-contact-limit space-y-2">
      <label className="ve2-label" htmlFor={id}>
        Адресов на одну компанию
      </label>
      <div className="flex items-center gap-2 max-w-sm">
        <input
          id={id}
          aria-invalid={!parsed.valid}
          aria-describedby={`${id}-hint ${id}-state`}
          className={`${HE.input} min-w-0`}
          inputMode="numeric"
          placeholder="без ограничения"
          value={draft}
          disabled={disabled}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (!disabled && changed) onSave(parsed.value);
            }
          }}
        />
        <button type="button" className={`${HE.btnGhost} shrink-0 whitespace-nowrap`} disabled={disabled || !changed} onClick={() => onSave(parsed.value)}>
          Применить
        </button>
      </div>
      <p id={`${id}-hint`} className={HE.muted}>
        Задайте до начала подготовки. Лимит общий для баз проекта и учитывается при сборе 500 контактов.
        Пустое поле: без ограничения. Остальные адреса сохраняются в резерве.
      </p>
      <p id={`${id}-state`} className={HE.muted} aria-live="polite">
        {!parsed.valid
          ? 'Укажите целое число от 1 до 100 или оставьте поле пустым.'
          : changed
            ? 'Нажмите «Применить», чтобы сохранить лимит перед подготовкой.'
            : `Сохранено: ${value === null ? 'без ограничения' : `не более ${value} адресов на компанию`}.`}
      </p>
      <details>
        <summary className="ve2-link cursor-pointer">Если базы уже собраны</summary>
        <p className={`${HE.muted} mt-2`}>
          Уменьшение лимита применяется к готовым базам автоматически, без нового сбора и оплаты.
          После изменения базу нужно одобрить заново. Увеличение или снятие лимита действует на новые сборы;
          для возврата адресов в готовую базу нажмите «Продолжить подготовку». Запущенные базы не меняются.
        </p>
      </details>
    </div>
  );
}
