'use client';

import Link from 'next/link';
import { AdminBotManagerPanel } from '@/components/AdminBotManagerPanel';
import { useIsTma } from '@/lib/useIsTma';

export default function AdminBotsPage() {
  const isTma = useIsTma();

  return (
    <div className={`max-w-6xl mx-auto px-4 ${isTma ? 'py-6 text-sm leading-relaxed' : 'py-10'}`}>
      <div className="mb-6">
        <Link href="/admin" className="text-sm font-medium text-blue-600 hover:text-blue-700">
          ← Назад в админку
        </Link>
      </div>
      <h1 className={`${isTma ? 'text-xl' : 'text-2xl'} font-bold mb-4 text-gray-900`}>
        Bot Manager
      </h1>
      <p className="text-gray-500 mb-6 text-sm">
        Управление ботами, подключёнными к порталу: остановка и запуск инстансов, просмотр логов с момента запуска.
      </p>
      <AdminBotManagerPanel />
    </div>
  );
}
