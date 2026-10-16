import type { ReactNode } from 'react';
import { Manrope } from 'next/font/google';

// «Жидкое стекло» Рассылки — слой стилей только под .sender-glass.
import './sender-glass.css';

/**
 * Шрифт «Рассылки» — ближе к Instantly. У них Averta, она платная; Manrope —
 * бесплатный геометрический гротеск того же склада и с кириллицей.
 * Слой охватывает все страницы инструмента: список, создание и настройки кампании.
 */
const senderFont = Manrope({
  subsets: ['latin', 'cyrillic'],
  display: 'swap',
});

export default function SenderLayout({ children }: { children: ReactNode }) {
  return <div className={`sender-glass ${senderFont.className}`}>{children}</div>;
}
