'use client';

/**
 * Переключатели рядов над графиком: какие показатели сейчас на экране.
 *
 * Заменяет собой легенду echarts, а не дополняет её. У легенды ровно та же
 * способность гасить ряд кликом, но об этом не догадываются — просьба «дать
 * возможность выбирать показатели» (09.10.2026) пришла именно от людей,
 * смотревших на легенду каждый день. Две одинаковые по смыслу панели рядом
 * были бы хуже одной явной, поэтому в графиках легенда выключается.
 *
 * Последний включённый ряд не гасится: пустой холст — не состояние, которое
 * кому-то нужно, а тупик, из которого потом неочевидно, как выйти.
 */
export interface SeriesPickerItem<K extends string> {
  key: K;
  label: string;
  color: string;
}

export default function SeriesPicker<K extends string>({
  items,
  visible,
  onToggle,
  className,
}: {
  items: SeriesPickerItem<K>[];
  /** Ключи включённых рядов. */
  visible: ReadonlySet<K>;
  onToggle: (key: K) => void;
  className?: string;
}) {
  const last = visible.size === 1;
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className ?? ''}`}>
      {items.map((item) => {
        const on = visible.has(item.key);
        const locked = on && last;
        return (
          <button
            key={item.key}
            type="button"
            aria-pressed={on}
            title={locked ? 'Хотя бы один показатель остаётся на графике' : undefined}
            onClick={() => { if (!locked) onToggle(item.key); }}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition ${
              on
                ? 'border-zinc-300 bg-white text-zinc-700'
                : 'border-transparent bg-zinc-100 text-zinc-400 hover:text-zinc-600'
            } ${locked ? 'cursor-default' : ''}`}
          >
            <span
              aria-hidden
              className="h-2.5 w-2.5 flex-none rounded-sm"
              style={{ background: on ? item.color : 'currentColor', opacity: on ? 1 : 0.45 }}
            />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
