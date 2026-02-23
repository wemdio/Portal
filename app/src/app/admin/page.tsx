'use client';

import Link from 'next/link';
import { Users, FileText, Database, Activity } from 'lucide-react';
import { useIsTma } from '@/lib/useIsTma';

export default function AdminPage() {
  const isTma = useIsTma();

  return (
    <div className={`max-w-6xl mx-auto px-4 ${isTma ? 'py-6 text-sm leading-relaxed' : 'py-10'}`}>
      <h1 className={`${isTma ? 'text-xl' : 'text-3xl'} font-bold mb-6 sm:mb-8 text-gray-900`}>Админ панель</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <Link
          href="/admin/users"
          className={`bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md hover:border-blue-300 transition-all group ${isTma ? 'p-4' : 'p-6'}`}
        >
          <div className="flex h-full flex-col">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Управление пользователями</h2>
                <p className="text-sm text-gray-500">Создание пользователей и назначение ролей</p>
              </div>
              <Users className="w-6 h-6 text-blue-600/80" />
            </div>
            <p className="mt-auto text-sm text-blue-600 font-medium">Перейти →</p>
          </div>
        </Link>

        <Link
          href="/admin/reglament"
          className={`bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md hover:border-blue-300 transition-all group ${isTma ? 'p-4' : 'p-6'}`}
        >
          <div className="flex h-full flex-col">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Регламенты</h2>
                <p className="text-sm text-gray-500">Создание и редактирование документов</p>
              </div>
              <FileText className="w-6 h-6 text-blue-600/80" />
            </div>
            <p className="mt-auto text-sm text-blue-600 font-medium">Перейти →</p>
          </div>
        </Link>

        <Link
          href="/admin/import"
          className={`bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md hover:border-blue-300 transition-all group ${isTma ? 'p-4' : 'p-6'}`}
        >
          <div className="flex h-full flex-col">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Импорт данных</h2>
                <p className="text-sm text-gray-500">Загрузка проектов из CSV</p>
              </div>
              <Database className="w-6 h-6 text-blue-600/80" />
            </div>
            <p className="mt-auto text-sm text-blue-600 font-medium">Перейти →</p>
          </div>
        </Link>

        <Link
          href="/admin/traces"
          className={`bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md hover:border-blue-300 transition-all group ${isTma ? 'p-4' : 'p-6'}`}
        >
          <div className="flex h-full flex-col">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Трассировки задач</h2>
                <p className="text-sm text-gray-500">Дерево выполнения задач и логи</p>
              </div>
              <Activity className="w-6 h-6 text-blue-600/80" />
            </div>
            <p className="mt-auto text-sm text-blue-600 font-medium">Перейти →</p>
          </div>
        </Link>
      </div>

    </div>
  );
}
