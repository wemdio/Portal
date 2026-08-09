import { Suspense } from 'react';
import { ClientReportsDashboard } from '@/components/client-reports/ClientReportsDashboard';

function ReportsFallback() {
  return (
    <main className="mx-auto max-w-6xl pb-10">
      <p className="ds-eyebrow mb-2">02 → Мониторинг</p>
      <h1 className="m-0 text-2xl font-semibold tracking-tight sm:text-3xl" style={{ color: 'var(--cp-paper)' }}>
        Статистика
      </h1>
      <div className="ds-card mt-6 px-5 py-12 text-center" role="status">
        <p className="text-sm font-medium" style={{ color: 'var(--cp-paper)' }}>Загружаем статистику…</p>
      </div>
    </main>
  );
}

export default function ClientReportsPage() {
  return (
    <Suspense fallback={<ReportsFallback />}>
      <ClientReportsDashboard />
    </Suspense>
  );
}
