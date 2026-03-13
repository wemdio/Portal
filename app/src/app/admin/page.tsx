'use client';

import Link from 'next/link';
import { Users, FileText, Database, Activity, MessageCircle, Bot } from 'lucide-react';
import { useIsTma } from '@/lib/useIsTma';

export default function AdminPage() {
  const isTma = useIsTma();

  const cardClass =
    'bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md hover:border-blue-300 transition-all group ' +
    (isTma ? 'p-4' : 'p-6');

  return (
    <div className={`max-w-6xl mx-auto px-4 ${isTma ? 'py-6 text-sm leading-relaxed' : 'py-10'}`}>
      <h1 className={`${isTma ? 'text-xl' : 'text-3xl'} font-bold mb-6 sm:mb-8 text-gray-900`}>Админ панель</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <Link href="/admin/users" className={cardClass}>
          <div className="flex h-full flex-col">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Управление пользователями</h2>
                <p className="text-sm text-gray-500">Создание пользователей и назначение ролей</p>
              </div>
              <Users className="h-6 w-6 text-blue-600/80" />
            </div>
            <p className="mt-auto text-sm font-medium text-blue-600">Перейти →</p>
          </div>
        </Link>

        <Link href="/admin/reglament" className={cardClass}>
          <div className="flex h-full flex-col">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Регламенты</h2>
                <p className="text-sm text-gray-500">Создание и редактирование документов</p>
              </div>
              <FileText className="h-6 w-6 text-blue-600/80" />
            </div>
            <p className="mt-auto text-sm font-medium text-blue-600">Перейти →</p>
          </div>
        </Link>

        <Link href="/admin/import" className={cardClass}>
          <div className="flex h-full flex-col">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Импорт данных</h2>
                <p className="text-sm text-gray-500">Загрузка проектов из CSV</p>
              </div>
              <Database className="h-6 w-6 text-blue-600/80" />
            </div>
            <p className="mt-auto text-sm font-medium text-blue-600">Перейти →</p>
          </div>
        </Link>

        <Link href="/admin/traces" className={cardClass}>
          <div className="flex h-full flex-col">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Трассировки задач</h2>
                <p className="text-sm text-gray-500">Дерево выполнения задач и логи</p>
              </div>
              <Activity className="h-6 w-6 text-blue-600/80" />
            </div>
            <p className="mt-auto text-sm font-medium text-blue-600">Перейти →</p>
          </div>
        </Link>

        <Link href="/admin/atmos-analytics" className={cardClass}>
          <div className="flex h-full flex-col">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Atmos‑аналитика</h2>
                <p className="text-sm text-gray-500">
                  История переписок из Atmos‑bot: фильтр по чатам и спецам, экспорт в CSV.
                </p>
              </div>
              <MessageCircle className="h-6 w-6 text-blue-600/80" />
            </div>
            <p className="mt-auto text-sm font-medium text-blue-600">Перейти →</p>
          </div>
        </Link>

        <Link href="/admin/bots" className={cardClass}>
          <div className="flex h-full flex-col">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Bot Manager</h2>
                <p className="text-sm text-gray-500">
                  Управление ботами портала — остановка, запуск, логи.
                </p>
              </div>
              <Bot className="h-6 w-6 text-blue-600/80" />
            </div>
            <p className="mt-auto text-sm font-medium text-blue-600">Перейти →</p>
          </div>
        </Link>
      </div>
    </div>
  );
}
