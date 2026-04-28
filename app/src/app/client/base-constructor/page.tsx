'use client';

import { BaseConstructorView } from '@/components/base-constructor/BaseConstructorView';

export default function ClientBaseConstructorPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 sm:mb-8">
        <h1 className="text-xl sm:text-2xl font-extrabold">Подготовить базу к запуску</h1>
        <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-text-m)' }}>
          Загрузите файл — мы очистим базу, найдём почты, проверим сайты и подготовим её к рассылке
        </p>
      </div>
      <BaseConstructorView clientMode />
    </div>
  );
}
