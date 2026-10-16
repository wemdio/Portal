import { PortalSpinner } from '@/components/PortalSpinner';

export default function PaymentsLoading() {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-gray-500">
      <PortalSpinner label="Загрузка оплат…" />
    </div>
  );
}
