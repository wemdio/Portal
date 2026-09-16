'use client';

import type { OutreachAccount } from '@/lib/tgOutreach/types';
import { healthToneClass, type HealthMark } from '@/lib/tgOutreach/accountHealth';
import { AccountAvatar } from './AccountAvatar';

/**
 * Сетка чекбоксов «отметь аккаунты» — по образцу «Кого греем» со вкладки
 * прогрева: та же строка (аватарка, ник, ФИО, дата добавления), плюс чип
 * состояния аккаунта. Без чипа выбор превращается в угадывание: в партии из
 * тридцати шести «Дмитриев» не видно, что половина на прогреве, а один
 * заморожен — отмечаешь тех, кто всё равно молчит.
 *
 * Компонент глупый: ни аккаунты, ни их статусы не загружает, только рисует
 * переданное. Владелец экрана решает, чем заполнить `marks` и что делать
 * с выбранным.
 */
export function AccountPicker({
  accounts,
  marks,
  selected,
  onChange,
}: {
  accounts: OutreachAccount[];
  /** Статус аккаунта (из describeSending) — чипом у ника. */
  marks?: Record<string, HealthMark>;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  // По дате добавления: свежая партия остаётся цельным блоком внизу, а не
  // размазывается по алфавиту имён, которые в партии одинаковые.
  const ordered = [...accounts].sort((a, b) => {
    const at = new Date(a.created_at).getTime();
    const bt = new Date(b.created_at).getTime();
    if (at !== bt) return at - bt;
    return a.session_name.localeCompare(b.session_name);
  });

  const allChecked = accounts.length > 0 && selected.size >= accounts.length;
  const someChecked = selected.size > 0 && !allChecked;

  return (
    <div>
      <div className="flex items-center gap-2 pb-1.5">
        <input
          type="checkbox"
          checked={allChecked}
          ref={(el) => { if (el) el.indeterminate = someChecked; }}
          onChange={(e) => onChange(e.target.checked ? new Set(accounts.map((a) => a.id)) : new Set())}
          aria-label="Выбрать все аккаунты"
          className="h-3.5 w-3.5 cursor-pointer accent-indigo-600"
        />
        <span className="text-xs font-medium text-gray-700">
          Выбрано {selected.size} из {accounts.length}
        </span>
      </div>
      <div className="grid max-h-72 grid-cols-1 gap-x-4 overflow-y-auto sm:grid-cols-2">
        {ordered.map((a) => {
          const mark = marks?.[a.id];
          const fullName = [a.first_name, a.last_name].filter(Boolean).join(' ').trim();
          return (
            <label
              key={a.id}
              className="flex cursor-pointer items-center gap-2 border-t border-gray-100 py-1.5 first:border-t-0"
            >
              <input
                type="checkbox"
                checked={selected.has(a.id)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(a.id); else next.delete(a.id);
                  onChange(next);
                }}
                aria-label={`Выбрать аккаунт ${a.tg_user_id ?? a.session_name}`}
                className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-indigo-600"
              />
              <AccountAvatar account={a} size={28} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium text-gray-800">
                    {a.tg_user_id ?? a.session_name}
                  </span>
                  {mark && (
                    <span
                      title={mark.detail}
                      className={`shrink-0 rounded px-1 py-0.5 text-[10px] ${healthToneClass(mark.tone)}`}
                    >
                      {mark.label}
                    </span>
                  )}
                </span>
                <span className="block truncate text-[11px] text-gray-500">
                  {fullName || 'профиль не прочитан'}
                  {a.tg_username ? ` · @${a.tg_username}` : ''}
                </span>
                {a.created_at && (
                  <span className="block truncate text-[10px] text-gray-400">
                    добавлен {new Date(a.created_at).toLocaleString('ru-RU', {
                      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
