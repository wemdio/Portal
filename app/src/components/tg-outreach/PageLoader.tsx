/**
 * Загрузка вкладки TG-аутрича: тот же кружок, что в плашке «Загрузка страницы…»
 * (класс `portal-spinner` в globals.css — переход от фиолетового к изумрудному и
 * мягкое свечение), только крупнее и по центру области. Один на все экраны
 * инструмента вместо россыпи «Загрузка…» с разными спиннерами.
 */
export function PageLoader({ label = 'Загрузка' }: { label?: string }) {
  return (
    <div className="flex min-h-[40vh] items-center justify-center" role="status" aria-label={label}>
      <span className="portal-spinner block" aria-hidden />
    </div>
  );
}
