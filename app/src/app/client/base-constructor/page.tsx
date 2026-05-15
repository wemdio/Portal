'use client';

import { Eraser } from 'lucide-react';
import { BaseConstructorView } from '@/components/base-constructor/BaseConstructorView';

export default function ClientBaseConstructorPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 sm:mb-8">
        <h1 className="text-xl sm:text-2xl font-extrabold flex items-center gap-2.5">
          <span
            className="inline-flex items-center justify-center w-8 h-8 rounded-xl"
            style={{ background: 'rgba(16,185,129,0.12)', color: '#10B981' }}
          >
            <Eraser className="h-4.5 w-4.5" />
          </span>
          Подготовить базу к запуску
        </h1>
        <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-text-m)' }}>
          Загрузите файл — мы очистим базу, найдём почты, проверим сайты и подготовим её к рассылке
        </p>
      </div>
      <BaseConstructorView clientMode />
    </div>
  );
}
