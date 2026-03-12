'use client';

import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { tgOutreachFetch } from '@/lib/tgOutreach/fetcher';

interface Props {
  accountId: string;
  onActionComplete: () => void;
}

const ACTIONS = [
  { id: 'check_status' as const, label: 'Проверить статус' },
  { id: 'check_spambot' as const, label: 'Проверить через @spambot' },
  { id: 'sync_profile' as const, label: 'Синхронизировать описание с Telegram' },
];

export function CheckDropdown({ accountId, onActionComplete }: Props) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleAction = async (actionId: string) => {
    setRunning(actionId);
    try {
      await tgOutreachFetch(`/accounts/${accountId}/actions`, {
        method: 'POST',
        json: { action: actionId },
      });
      onActionComplete();
    } catch {
      // silent
    } finally {
      setRunning(null);
      setOpen(false);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 transition-colors"
      >
        Проверить
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 w-64 rounded-lg border border-gray-200 bg-white py-1 shadow-xl">
          {ACTIONS.map((action) => (
            <button
              key={action.id}
              onClick={() => handleAction(action.id)}
              disabled={running !== null}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {running === action.id && <Loader2 className="h-3 w-3 animate-spin" />}
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
