'use client';

import { useId, useState } from 'react';
import { HE } from './design';
import { DownloadVerifiedContacts } from './DownloadVerifiedContacts';

/** A local download selection only. It never updates outreach setup/approvals. */
export function CombinedContactsDownload({ projectId, hypotheses }: {
  projectId: string;
  hypotheses: Array<{ id: string; title: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const regionId = useId();
  const available = new Set(hypotheses.map(hypothesis => hypothesis.id));
  const selectedIds = selected.filter(id => available.has(id));
  if (hypotheses.length < 2) return null;
  return (
    <div className="space-y-3">
      <button type="button" className={HE.btnGhost} aria-expanded={open} aria-controls={regionId}
        disabled={busy} onClick={() => setOpen(value => !value)}>
        {open ? 'Закрыть выбор для скачивания' : 'Скачать несколько баз одним файлом'}
      </button>
      {open ? <div id={regionId} className="space-y-3 border-y border-[var(--ve2-line)] py-4">
        <fieldset disabled={busy} className="space-y-2">
          <legend className="ve2-h3 mb-2">Базы для скачивания</legend>
          <div className="max-h-72 overflow-y-auto space-y-1">
            {hypotheses.map(hypothesis => <label key={hypothesis.id} className="flex min-h-10 items-start gap-3 py-2">
              <input type="checkbox" className="ve2-cbx mt-1" checked={selectedIds.includes(hypothesis.id)}
                disabled={!selectedIds.includes(hypothesis.id) && selectedIds.length >= 50}
                onChange={event => setSelected(current => event.target.checked
                  ? [...current.filter(id => available.has(id)), hypothesis.id] : current.filter(id => id !== hypothesis.id))} />
              <span>{hypothesis.title}</span>
            </label>)}
          </div>
        </fieldset>
        <p className={HE.muted}>Выбор относится только к файлу. Кампании и согласования сохраняются.</p>
        <DownloadVerifiedContacts key={selectedIds.slice().sort().join(',')} projectId={projectId}
          hypothesisIds={selectedIds} onBusyChange={setBusy} />
      </div> : null}
    </div>
  );
}
