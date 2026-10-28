'use client';

import { useRef, useState } from 'react';
import { ArrowUpRight, Copy, Pencil } from 'lucide-react';
import {
  BOARD_CONTACT_FIELDS, boardContactChanges, boardContactDisplay, boardContactDraft,
  boardContactHref, formatBoardContactText,
  type BoardContactPatch, type BoardContactValues,
} from '@/lib/leadBoard/boardContacts';

const ACTION = 'inline-flex min-h-11 sm:min-h-7 items-center gap-1.5 rounded px-1 py-1 text-[12px] text-[var(--cp-paper-mute)] hover:text-[var(--cp-paper)] hover:bg-[var(--cp-surface-active)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cp-paper)] disabled:opacity-50 disabled:cursor-wait';
const FIELD = 'w-full min-h-11 sm:min-h-0 resize-y rounded border border-[var(--cp-divider-strong)] bg-[var(--cp-ink)] px-2 py-1.5 text-[13px] leading-5 text-[var(--cp-paper)] placeholder:text-[var(--cp-paper-faint)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--cp-paper)] disabled:opacity-50';

export function ContactCell({ value, disabled, onSave, onCopy }: {
  value: BoardContactValues;
  disabled?: boolean;
  onSave: (patch: BoardContactPatch) => Promise<boolean>;
  onCopy: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [baseline, setBaseline] = useState(() => boardContactDraft(value));
  const [draft, setDraft] = useState(() => boardContactDraft(value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const current = boardContactDraft(value);
  const filled = BOARD_CONTACT_FIELDS.filter(({ key }) => current[key].trim());

  function beginEdit() {
    const next = boardContactDraft(value);
    setBaseline(next); setDraft(next); setError(''); setEditing(true);
  }

  function closeEditor() {
    setEditing(false); setError('');
    requestAnimationFrame(() => editButton.current?.focus());
  }

  async function save() {
    if (pending.current || disabled) return;
    const patch = boardContactChanges(baseline, draft);
    if (!Object.keys(patch).length) { closeEditor(); return; }
    const tooLong = BOARD_CONTACT_FIELDS.find(({ key, limit }) =>
      draft[key].trim() !== baseline[key].trim() && draft[key].trim().length > limit);
    if (tooLong) { setError(`«${tooLong.label}»: максимум ${tooLong.limit} символов.`); return; }
    pending.current = true; setSaving(true); setError('');
    try {
      if (await onSave(patch)) closeEditor();
      else setError('Не удалось сохранить. Ваши изменения остались в полях, попробуйте ещё раз.');
    } catch {
      setError('Не удалось сохранить. Ваши изменения остались в полях, попробуйте ещё раз.');
    } finally { pending.current = false; setSaving(false); }
  }

  return (
    <div className="w-[17rem] sm:w-[19rem] max-w-full py-0.5" data-contact-cell>
      {editing ? (
        <form aria-label="Редактирование контактов" onSubmit={(event) => { event.preventDefault(); void save(); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !saving) { event.preventDefault(); event.stopPropagation(); closeEditor(); }
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); }
          }}>
          <div className="space-y-2.5">
            {BOARD_CONTACT_FIELDS.map(({ key, label, limit }, index) => (
              <label key={key} className="block">
                <span className="mb-1 block text-[11px] font-medium text-[var(--cp-paper-mute)]">{label}</span>
                <textarea
                  autoFocus={index === 0} value={draft[key]} aria-label={label}
                  rows={key === 'address' ? 3 : key === 'phone' ? 2 : 1}
                  maxLength={Math.max(limit, baseline[key].length)} disabled={saving || disabled}
                  placeholder={key === 'phone' ? 'Номера через точку с запятой' : key === 'telegram' ? '@username или ссылка' : key === 'whatsapp' ? 'Ссылка или номер с кодом страны' : 'Город, улица, дом'}
                  onChange={(event) => setDraft((prev) => ({ ...prev, [key]: event.target.value }))}
                  className={`${FIELD} ${key === 'address' ? '' : 'ds-mono text-[12px]'}`}
                />
              </label>
            ))}
          </div>
          {error && <p role="alert" className="mt-2 text-[12px] leading-4 text-[var(--cp-red)]">{error}</p>}
          <div className="mt-3 flex items-center gap-2">
            <button type="submit" disabled={saving || disabled} className="ds-btn-primary min-h-11 sm:min-h-7 !px-2.5 !py-1.5 !text-[12px]">{saving ? 'Сохраняю…' : 'Сохранить'}</button>
            <button type="button" disabled={saving} onClick={closeEditor} className={ACTION}>Отмена</button>
          </div>
        </form>
      ) : (
        <>
          {filled.length ? (
            <dl className="space-y-2.5">
              {filled.map(({ key, label }) => (
                <div key={key}>
                  <dt className="mb-0.5 text-[10px] font-medium tracking-[0.02em] text-[var(--cp-paper-faint)]">{label}</dt>
                  <dd className={`text-[13px] leading-5 whitespace-pre-wrap [overflow-wrap:anywhere] ${key === 'address' ? 'text-[var(--cp-paper-mute)]' : 'text-[var(--cp-paper)]'}`}>
                    {(key === 'phone' ? current[key].split(/;|\r?\n/gu).map((item) => item.trim()).filter(Boolean) : [current[key]]).map((item, index) => {
                      const href = boardContactHref(key, item);
                      return <span className="block" key={index}>{href ? (
                        <a href={href} target={key === 'phone' ? undefined : '_blank'} rel="noopener noreferrer"
                          className="inline-block min-h-11 sm:min-h-0 py-2 sm:py-0 rounded underline decoration-[var(--cp-divider-strong)] underline-offset-4 hover:decoration-[var(--cp-paper)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cp-paper)]"
                          aria-label={`${label}: ${boardContactDisplay(key, item)}`}>
                          {boardContactDisplay(key, item)}{key !== 'phone' && <ArrowUpRight size={12} className="ml-1 inline align-text-top text-[var(--cp-paper-faint)]" aria-hidden="true" />}
                        </a>
                      ) : item}</span>;
                    })}
                  </dd>
                </div>
              ))}
            </dl>
          ) : <p className="text-[12px] text-[var(--cp-paper-faint)]">Контакты пока не указаны</p>}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button ref={editButton} type="button" disabled={disabled} className={ACTION}
              aria-label={filled.length ? 'Изменить контакты' : 'Добавить контакты'} onClick={beginEdit}>
              <Pencil size={12} aria-hidden="true" />{filled.length ? 'Изменить' : 'Добавить контакты'}
            </button>
            {filled.length > 0 && <button type="button" className={ACTION} aria-label="Копировать контакты"
              onClick={() => onCopy(formatBoardContactText(value))}><Copy size={12} aria-hidden="true" />Копировать</button>}
          </div>
        </>
      )}
    </div>
  );
}
