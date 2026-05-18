'use client';

import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';

const InvoicesPageView = dynamic(() => import('./InvoicesPageView'), {
  loading: () => (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-zinc-400">
      <Loader2 className="h-7 w-7 animate-spin" aria-hidden />
      <p className="text-sm">Загрузка счетов…</p>
    </div>
  ),
});

export default function InvoicesPage() {
  return <InvoicesPageView />;
}
