'use client';

import { EngProjectsList } from '@/components/client-eng/EngProjectsList';

/**
 * /client/eng — клиентский ENG-кабинет «Движка вертикалей» (список проектов +
 * создание). Тексты страницы — английские (кабинет для ENG-клиентов);
 * i18n-контур RU-раздела не трогаем.
 */
export default function ClientEngPage() {
  return (
    <div className="mx-auto max-w-4xl xl:max-w-6xl">
      <header className="mb-6 sm:mb-8">
        <h1 className="text-xl sm:text-2xl font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
          ENG Outreach
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--cp-text-m)' }}>
          Verticals engine: research your market, review verticals, edit letters, collect a base and launch — all in English.
        </p>
      </header>
      <EngProjectsList />
    </div>
  );
}
