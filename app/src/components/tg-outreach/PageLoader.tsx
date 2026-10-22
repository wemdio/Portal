/**
 * Загрузка вкладки TG-аутрича: один крутящийся круг по центру. Один на все
 * экраны инструмента вместо россыпи «Загрузка…» с разными спиннерами.
 * Кольцо рисуется рамкой (светлая дорожка и яркая дуга), цвета заданы явно —
 * тёмная тема портала не подменяет их.
 */
export function PageLoader({ label = 'Загрузка' }: { label?: string }) {
  return (
    <div className="flex min-h-[40vh] items-center justify-center" role="status" aria-label={label}>
      <span
        className="block h-9 w-9 animate-spin rounded-full border-[3px] border-[rgba(129,140,248,0.2)] border-t-[#818cf8] motion-reduce:animate-none"
        style={{ filter: 'drop-shadow(0 0 6px rgba(129,140,248,0.45))' }}
      />
    </div>
  );
}
