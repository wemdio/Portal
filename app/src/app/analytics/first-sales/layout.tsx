import type { ReactNode } from 'react';

// Фон «жидкого стекла» на весь экран — как в «Рассылке».
import '../../liquid-scene.css';

export default function FirstSalesLayout({ children }: { children: ReactNode }) {
  return <div className="liquid-scene">{children}</div>;
}
