'use client';

import { useMemo, useState } from 'react';
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import { accountLabel } from '@/lib/tgOutreach/accountLabel';
import { ARCHIVE_REASONS, archiveReasonLabel, type ArchiveReason } from '@/lib/tgOutreach/accountArchive';
import type { OutreachAccount } from '@/lib/tgOutreach/types';

function formatArchivedAt(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Архив аккаунтов — раскрывающийся блок над списком кампании.
 *
 * Свёрнут по умолчанию: заходят сюда за живыми аккаунтами, а архив нужен
 * изредка — посмотреть, что и когда умерло, или вернуть аккаунт. В заголовке
 * счётчики по причинам, чтобы картина партии читалась без раскрытия.
 */
export function AccountArchiveSection({
  items,
  restoringIds,
  onRestore,
}: {
  items: OutreachAccount[];
  restoringIds: string[];
  onRestore: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);

  const byReason = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of items) counts.set(a.archive_reason ?? '', (counts.get(a.archive_reason ?? '') ?? 0) + 1);
    return [...counts.entries()].sort((x, y) => y[1] - x[1]);
  }, [items]);

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-2 px-4 py-3 text-left cursor-pointer"
      >
        {open ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
        <Archive className="h-4 w-4 text-gray-500" />
        <span className="text-sm font-medium text-gray-700">Архив аккаунтов</span>
        <span className="text-sm text-gray-400">({items.length})</span>
        {byReason.length > 0 && (
          <span className="ml-auto flex flex-wrap gap-1.5">
            {byReason.map(([reason, count]) => (
              <span key={reason} className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">
                {archiveReasonLabel(reason)}: {count}
              </span>
            ))}
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-gray-100">
          {items.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-gray-400">
              В архиве пусто. Отметьте аккаунты в списке и нажмите «В архив».
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50/60 text-left text-[11px] uppercase tracking-wide text-gray-500">
                    <th className="px-4 py-2 font-medium">Аккаунт</th>
                    <th className="px-4 py-2 font-medium">Телефон</th>
                    <th className="px-4 py-2 font-medium">Причина</th>
                    <th className="px-4 py-2 font-medium">В архиве с</th>
                    <th className="px-4 py-2 font-medium">Кто убрал</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {items.map((a) => {
                    const restoring = restoringIds.includes(a.id);
                    return (
                      <tr key={a.id} className="hover:bg-gray-50/60">
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-gray-800">{accountLabel(a)}</div>
                          {accountLabel(a) !== a.session_name && (
                            <div className="text-[11px] text-gray-400">{a.session_name}</div>
                          )}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs text-gray-600">{a.phone || '—'}</td>
                        <td className="px-4 py-2.5">
                          <div className="text-gray-700">{archiveReasonLabel(a.archive_reason)}</div>
                          {a.archive_note && <div className="max-w-xs text-xs text-gray-500">{a.archive_note}</div>}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-gray-600">{formatArchivedAt(a.archived_at)}</td>
                        <td className="px-4 py-2.5 text-xs text-gray-500">{a.archived_by_name || '—'}</td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            type="button"
                            disabled={restoring}
                            onClick={() => onRestore([a.id])}
                            title="Вернуть в список кампании. Вернётся выключенным — проверьте и включите сами."
                            className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 px-3 py-1 text-xs text-gray-700 transition hover:border-indigo-300 hover:bg-indigo-50 disabled:opacity-50 cursor-pointer"
                          >
                            {restoring ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArchiveRestore className="h-3.5 w-3.5" />}
                            Вернуть
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Окно «Убрать в архив»: причина из списка, для «Другое» — обязательный комментарий. */
export function ArchiveAccountsDialog({
  count,
  saving,
  error,
  onCancel,
  onConfirm,
}: {
  count: number;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (reason: ArchiveReason, note: string) => void;
}) {
  const [reason, setReason] = useState<ArchiveReason | null>(null);
  const [note, setNote] = useState('');
  const needNote = reason === 'other';
  const canSubmit = reason != null && (!needNote || note.trim().length > 0) && !saving;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel} role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">
            {count === 1 ? 'Убрать аккаунт в архив' : `Убрать в архив: ${count}`}
          </h2>
          <button type="button" onClick={onCancel} className="text-gray-400 hover:text-gray-600 cursor-pointer">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-6 py-5">
          <p className="text-xs text-gray-500">
            Аккаунт выключится и пропадёт из списка кампании — в рассылке и прогреве он больше не участвует.
            Вернуть можно из блока «Архив аккаунтов» сверху.
          </p>

          <div>
            <p className="mb-2 text-sm font-medium text-gray-800">Причина</p>
            <div className="grid grid-cols-2 gap-1.5">
              {ARCHIVE_REASONS.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setReason(r.id)}
                  aria-pressed={reason === r.id}
                  className={`rounded-lg border px-3 py-2 text-left text-sm transition cursor-pointer ${
                    reason === r.id
                      ? 'border-indigo-400 bg-indigo-50 text-indigo-800'
                      : 'border-gray-200 text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-sm font-medium text-gray-800">
              Комментарий{needNote ? '' : <span className="font-normal text-gray-400"> — по желанию</span>}
            </p>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder={needNote ? 'Что случилось с аккаунтом' : 'Например: FloodWait 6 дней с 12.09'}
              className="w-full resize-y rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 outline-none focus:border-indigo-400"
            />
          </div>

          {error && <p className="text-sm text-rose-600">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-100 px-6 py-4">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-gray-200 px-4 py-2 text-xs text-gray-600 hover:bg-gray-100 transition cursor-pointer"
          >
            Отмена
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => reason && onConfirm(reason, note)}
            className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-5 py-2 text-xs font-semibold text-white hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Archive className="h-3.5 w-3.5" />}
            В архив
          </button>
        </div>
      </div>
    </div>
  );
}
