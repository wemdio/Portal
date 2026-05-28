'use client';

import { BaseConstructorView } from '@/components/base-constructor/BaseConstructorView';

export default function ClientBaseConstructorPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 sm:mb-8">
        {/* Page eyebrow mirrors the sidebar group. «Базы» lives in
            CLIENT_NAV_GROUPS[0] («01 → Старт»), so the page eyebrow reads
            «01 → Старт» — same convention as /client (campaigns) and
            /client/leads. */}
        <p className="ds-eyebrow mb-2">
          01<span aria-hidden> → </span>Старт
        </p>
        <h1
          className="text-xl sm:text-2xl font-bold m-0"
          style={{ color: 'var(--cp-paper)' }}
        >
          Подготовить базу к запуску
        </h1>
        <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
          Загрузите файл — мы очистим базу, найдём почты, проверим сайты и подготовим её к рассылке
        </p>
      </header>
      <BaseConstructorView clientMode />
    </div>
  );
}
