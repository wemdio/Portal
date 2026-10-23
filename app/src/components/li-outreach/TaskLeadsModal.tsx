'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** Контакты, которые собрала задача скрапера, — окно по значку «глаз» в списке задач. */

export interface TaskLead {
  id: string;
  name: string;
  position: string | null;
  company: string | null;
  profile_url: string | null;
}

export default function TaskLeadsModal({
  title,
  load,
  onClose,
}: {
  title: string;
  load: () => Promise<{ leads: TaskLead[]; total: number; listMissing?: boolean }>;
  onClose: () => void;
}) {
  const [data, setData] = useState<{ leads: TaskLead[]; total: number; listMissing?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    load()
      .then((d) => { if (active) setData(d); })
      .catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : 'Не удалось загрузить контакты'); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const esc = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className="li-hover-card flex max-h-[80vh] w-full max-w-3xl flex-col rounded-2xl border shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-5 py-3">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold">{title}</h3>
            <p className="text-xs text-zinc-500">
              {data ? (data.leads.length < data.total ? `Показаны первые ${data.leads.length} из ${data.total}` : `Контактов: ${data.total}`) : 'Загрузка…'}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Закрыть" className="cursor-pointer rounded-lg p-1.5 text-zinc-500 hover:bg-black/10">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {error ? (
            <p className="text-sm text-red-600">{error}</p>
          ) : !data ? (
            <div className="flex justify-center py-10"><div className="h-7 w-7 animate-spin rounded-full border-2 border-zinc-300 border-t-blue-600" /></div>
          ) : data.listMissing ? (
            <p className="py-8 text-center text-sm text-zinc-500">У задачи не указана база, поэтому контакты показать нельзя.</p>
          ) : data.leads.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-500">Контактов за время этой задачи не найдено.</p>
          ) : (
            <table className="w-full table-fixed text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-xs text-zinc-500">
                  <th className="px-2 py-1.5 text-left font-medium">Имя</th>
                  <th className="w-[32%] px-2 py-1.5 text-left font-medium">Должность</th>
                  <th className="w-[24%] px-2 py-1.5 text-left font-medium">Компания</th>
                </tr>
              </thead>
              <tbody>
                {data.leads.map((lead) => (
                  <tr key={lead.id} className="border-b border-zinc-100">
                    <td className="truncate px-2 py-1.5 font-medium">
                      {lead.profile_url ? (
                        <a href={lead.profile_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{lead.name}</a>
                      ) : lead.name}
                    </td>
                    <td className="truncate px-2 py-1.5 text-zinc-600" title={lead.position ?? ''}>{lead.position ?? '—'}</td>
                    <td className="truncate px-2 py-1.5 text-zinc-600" title={lead.company ?? ''}>{lead.company ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
