import { PortalSpinner } from '@/components/PortalSpinner';

export default function BillingCalendarLoading() {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-gray-500">
      <PortalSpinner label="Загрузка календаря оплат…" />
    </div>
  );
}
