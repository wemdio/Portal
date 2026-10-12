'use client';

import { useId, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import { downloadBaseCsvResponse } from '@/lib/verticalEngineV2/baseCsv';
import { VE_API } from './api';
import { HE, Spinner } from './design';

/** Fetch the complete saved audience only on demand, never during polling. */
export function DownloadVerifiedContacts({ projectId, hypothesisId }: {
  projectId: string;
  hypothesisId: string;
}) {
  const [downloading, setDownloading] = useState(false);
  const [notice, setNotice] = useState<{ message: string; empty: boolean } | null>(null);
  const inFlight = useRef(false);
  const descriptionId = useId();
  const download = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setDownloading(true);
    setNotice(null);
    try {
      const query = new URLSearchParams({ hypothesis_id: hypothesisId });
      const response = await authFetch(`${VE_API}/projects/${encodeURIComponent(projectId)}/contacts/export?${query}`);
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: unknown } | null;
        setNotice({
          message: typeof data?.error === 'string' && data.error.trim() ? data.error
            : response.status === 409 ? 'Проверенных контактов для скачивания пока нет.'
              : 'Не удалось скачать контакты. Попробуйте ещё раз.',
          empty: response.status === 409,
        });
        return;
      }
      await downloadBaseCsvResponse(response, `hypothesis-${hypothesisId}-verified.csv`);
    } catch {
      setNotice({ message: 'Не удалось скачать контакты. Попробуйте ещё раз.', empty: false });
    } finally {
      inFlight.current = false;
      setDownloading(false);
    }
  };

  return (
    <div className="min-w-0 space-y-1.5">
      <button type="button" className={`${HE.btnGhost} max-w-full !whitespace-normal text-left`}
        disabled={downloading} aria-busy={downloading} aria-describedby={descriptionId}
        onClick={() => void download()}>
        {downloading ? <Spinner className="h-4 w-4 shrink-0" /> : <Download aria-hidden className="h-4 w-4 shrink-0" />}
        {downloading ? 'Готовим CSV…' : 'Скачать все проверенные контакты'}
      </button>
      <p id={descriptionId} className={HE.faint}>Весь накопленный список, включая доборы</p>
      {notice ? <p role={notice.empty ? 'status' : 'alert'}
        className={notice.empty ? HE.muted : 'text-sm text-[var(--ve2-err)]'}>{notice.message}</p> : null}
    </div>
  );
}
