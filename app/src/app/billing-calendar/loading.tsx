export default function BillingCalendarLoading() {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-gray-500">
      <div
        className="h-8 w-8 rounded-full border-2 border-blue-600 border-t-transparent animate-spin"
        aria-hidden
      />
      <p className="text-sm">Загрузка календаря оплат…</p>
    </div>
  );
}
