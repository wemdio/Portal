'use client';

import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';

const TechCalendarView = dynamic(() => import('./TechCalendarView'), {
  loading: () => (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-gray-500">
      <Loader2 className="h-8 w-8 animate-spin text-blue-600" aria-hidden />
      <p className="text-sm">Загрузка календаря технички…</p>
    </div>
  ),
});

export default function TechCalendarPage() {
  return <TechCalendarView />;
}
