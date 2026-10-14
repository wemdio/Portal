'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { LeadVerdict, ThreadVerdictDto } from '@/lib/senderLeads/history';
import { fetchThreadVerdict, setLeadVerdict } from './api';

const AI_STATUS: Record<string, string> = {
  lead: 'лид',
  not_lead: 'не лид',
  pending: 'ответ в очереди на оценку',
  error: 'оценить не удалось',
};

/**
 * Полоса квалификации в окне переписки «Рассылки»: метка переписки,
 * объяснение ИИ и кнопки «Это лид» / «Не лид». Ручная метка приоритетнее ИИ
 * и в ТГ-чат ничего не шлёт.
 */
export function LeadVerdictBar({ recipientId, onChange }: { recipientId: string; onChange?: () => void }) {
  const [data, setData] = useState<ThreadVerdictDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchThreadVerdict(recipientId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        /* полоса — дополнение к переписке: без неё окно работает как раньше */
      });
    return () => {
      cancelled = true;
    };
  }, [recipientId]);

  if (!data) return null;

  const mark = async (verdict: LeadVerdict) => {
    setBusy(true);
    setError(null);
    try {
      const res = await setLeadVerdict(recipientId, verdict);
      setData((prev) => (prev ? { ...prev, verdict: res.verdict, verdictSource: res.verdictSource, verdictAt: res.verdictAt } : prev));
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось поставить метку');
    } finally {
      setBusy(false);
    }
  };

  const last = data.lastQualification;
  const manual = data.verdictSource === 'manual' ? data.verdict : null;
  const label = data.verdict
    ? `${data.verdict === 'lead' ? 'Лид' : 'Не лид'}${manual ? ' (вручную)' : ''}`
    : 'Без метки';
  const aiLine = last && last.status !== 'skipped'
    ? `ИИ: ${AI_STATUS[last.status] ?? last.status}${last.aiReason ? ` — ${last.aiReason}` : ''}`
    : null;

  return (
    <div className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-zinc-500">Квалификация:</span>
          <span
            className={`rounded-md px-2 py-0.5 text-xs font-medium ${
              data.verdict === 'lead'
                ? 'bg-violet-100 text-violet-700'
                : data.verdict === 'not_lead'
                  ? 'bg-zinc-200 text-zinc-600'
                  : 'bg-white text-zinc-500'
            }`}
          >
            {label}
          </span>
          {last?.tgSentAt ? <span className="text-xs text-blue-700">ушёл в чат</span> : null}
        </div>
        <div className="flex items-center gap-2">
          {busy ? <Loader2 className="h-4 w-4 animate-spin text-zinc-400" /> : null}
          <button
            type="button"
            onClick={() => void mark('lead')}
            disabled={busy || manual === 'lead'}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50"
          >
            Это лид
          </button>
          <button
            type="button"
            onClick={() => void mark('not_lead')}
            disabled={busy || manual === 'not_lead'}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50"
          >
            Не лид
          </button>
        </div>
      </div>
      {aiLine ? <p className="mt-1.5 text-xs text-zinc-600">{aiLine}</p> : null}
      {error ? <p className="mt-1.5 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
