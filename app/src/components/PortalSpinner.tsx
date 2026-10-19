/** Спиннер загрузки: кольцо фиолетовый → изумрудный (стили — .portal-spinner в globals.css). */
export function PortalSpinner({ small = false, label }: { small?: boolean; label?: string }) {
  const ring = <span className={`portal-spinner${small ? ' portal-spinner-sm' : ''} block shrink-0`} aria-hidden />;
  if (!label) return <span role="status" aria-label="Загрузка" className="inline-flex">{ring}</span>;
  return (
    <span role="status" className="inline-flex flex-col items-center gap-3 text-sm text-zinc-500">
      {ring}
      <span>{label}</span>
    </span>
  );
}
