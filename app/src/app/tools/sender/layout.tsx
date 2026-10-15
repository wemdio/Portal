import type { ReactNode } from 'react';
import { Manrope } from 'next/font/google';

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
  return <div className={senderFont.className}>{children}</div>;
}
