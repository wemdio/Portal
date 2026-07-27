import { Inter, JetBrains_Mono } from 'next/font/google';

/**
 * Гостевая таблица лидов — визуальный язык клиентского портала (DESIGN.md,
 * «Decisive Editorial Dark»): те же шрифтовые переменные и .client-portal
 * токены, что у /client, но без сайдбара и авторизации (публичный маршрут).
 */
const inter = Inter({
  subsets: ['latin', 'cyrillic'],
  display: 'swap',
  variable: '--font-inter',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin', 'cyrillic'],
  display: 'swap',
  variable: '--font-mono',
});

export default function LeadsBoardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`client-portal ${inter.variable} ${jetbrainsMono.variable}`}>
      {children}
    </div>
  );
}
