'use client';

import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
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
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const MENU_WIDTH = 256;
  const MENU_HEIGHT = 128;
  const MENU_GAP = 4;

  const updateMenuPosition = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;

    const spaceBelow = window.innerHeight - rect.bottom;
    const openUpwards = spaceBelow < MENU_HEIGHT + MENU_GAP;
    const top = openUpwards ? rect.top - MENU_HEIGHT - MENU_GAP : rect.bottom + MENU_GAP;
    const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));

    setMenuPosition({ top, left });
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [open]);

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
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 transition-colors"
      >
        Проверить
        <ChevronDown className="h-3 w-3" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-[80] w-64 rounded-lg border border-gray-200 bg-white py-1 shadow-xl"
            style={{ top: menuPosition.top, left: menuPosition.left }}
          >
            {ACTIONS.map((action) => (
              <button
                key={action.id}
                onClick={() => handleAction(action.id)}
                disabled={running !== null}
                className="flex w-full items-center justify-start gap-2 border-l-2 border-transparent px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:border-emerald-500 hover:bg-emerald-50 hover:text-emerald-800 disabled:opacity-50"
              >
                {running === action.id && <Loader2 className="h-3 w-3 animate-spin" />}
                <span className="text-left leading-5">{action.label}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}
