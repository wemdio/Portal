'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { fetchEgressIps, setEgressAcceptsNew, type EgressIpDto } from './api';
import { EgressPanel } from './EgressPanel';

/**
 * Вкладка «Адреса отправки»: серверы и адреса, с которых уходят письма.
 * Отдельно от ящиков — это настройка инфраструктуры, а не работа со списком.
 * Клик по адресу открывает «Ящики» с фильтром по нему.
 */
export function EgressTab({ onOpenMailboxes }: { onOpenMailboxes: (ip: string) => void }) {
  const [ips, setIps] = useState<EgressIpDto[]>([]);
  const [unassigned, setUnassigned] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyIp, setBusyIp] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchEgressIps();
      setIps(res.ips);
      setUnassigned(res.unassigned);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить адреса');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Пульс воркеров — раз в 30 с; чаще опрашивать незачем.
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const toggleAcceptsNew = async (row: EgressIpDto) => {
    setBusyIp(row.ip);
    setError(null);
    try {
      await setEgressAcceptsNew(row.ip, !row.acceptsNew);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось переключить адрес');
    } finally {
      setBusyIp(null);
    }
  };

  return (
    <div className="space-y-4">
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {loading ? (
        <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Загрузка…
        </div>
      ) : ips.length ? (
        <EgressPanel
          ips={ips}
          unassigned={unassigned}
          busyIp={busyIp}
          onOpenMailboxes={onOpenMailboxes}
          onToggleAcceptsNew={(row) => void toggleAcceptsNew(row)}
        />
      ) : (
        <p className="px-5 py-10 text-center text-sm text-zinc-500">Адресов отправки пока нет.</p>
      )}
    </div>
  );
}
