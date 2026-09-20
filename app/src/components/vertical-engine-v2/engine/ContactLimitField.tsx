'use client';

import { useState } from 'react';
import { HE } from './design';

/** Project-level "addresses per company taken into work". Empty = no limit. */
export function parseContactLimitDraft(draft: string): { valid: boolean; value: number | null } {
  const text = draft.trim();
  if (!text) return { valid: true, value: null };
  if (!/^\d{1,3}$/.test(text)) return { valid: false, value: null };
  const value = Number(text);
  return value >= 1 && value <= 100 ? { valid: true, value } : { valid: false, value: null };
}

export function ContactLimitField({ value, disabled, onSave }: {
  value: number | null; disabled: boolean; onSave: (next: number | null) => void;
}) {
  // The parent remounts the field (key = saved value) when the saved limit changes.
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  const parsed = parseContactLimitDraft(draft);
  const changed = parsed.valid && parsed.value !== value;
  return (
    <div className="space-y-1">
      <label className="ve2-label">
        Адресов на одну компанию
        <span className="flex items-center gap-2">
          <input
            aria-label="Адресов на одну компанию"
            aria-invalid={!parsed.valid}
            className={HE.input}
            inputMode="numeric"
            placeholder="без ограничения"
            value={draft}
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && changed) onSave(parsed.value); }}
          />
          <button type="button" className={HE.btnGhost} disabled={disabled || !changed} onClick={() => onSave(parsed.value)}>
            Применить
          </button>
        </span>
      </label>
      {!parsed.valid ? <p className={HE.muted} role="alert">Укажите целое число от 1 до 100 или оставьте поле пустым.</p> : null}
      <p className={HE.muted}>
        Сколько адресов одной компании брать в работу. Пусто — без ограничения. Лишние адреса не удаляются:
        они остаются в резерве. Уменьшение применяется к уже собранным базам само, без нового сбора и без
        оплаты — подтверждение базы при этом сбрасывается, её нужно проверить заново. Увеличение или снятие
        лимита действует на новые сборы; чтобы вернуть адреса в готовую базу, нажмите «Продолжить подготовку».
        Цель в 500 контактов считается уже с этим ограничением. Запущенные базы не меняются.
      </p>
    </div>
  );
}
