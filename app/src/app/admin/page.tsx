'use client';

import Link from 'next/link';
import { AdminTracesPanel } from '@/components/AdminTracesPanel';
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
            <div className="flex items-center mb-4">
              <div className="ml-4">
                <h2 className="text-lg font-semibold text-gray-900">Управление пользователями</h2>
                <p className="text-sm text-gray-500">Создание пользователей и назначение ролей</p>
              </div>
            </div>
            <p className="mt-auto text-sm text-blue-600 font-medium">Перейти →</p>
          </div>
        </Link>

        <Link
          href="/admin/reglament"
          className={`bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md hover:border-blue-300 transition-all group ${isTma ? 'p-4' : 'p-6'}`}
        >
          <div className="flex h-full flex-col">
            <div className="flex items-center mb-4">
              <div className="ml-4">
                <h2 className="text-lg font-semibold text-gray-900">Регламенты</h2>
                <p className="text-sm text-gray-500">Создание и редактирование документов</p>
              </div>
            </div>
            <p className="mt-auto text-sm text-blue-600 font-medium">Перейти →</p>
          </div>
        </Link>

        <Link
          href="/admin/import"
          className={`bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md hover:border-blue-300 transition-all group ${isTma ? 'p-4' : 'p-6'}`}
        >
          <div className="flex h-full flex-col">
            <div className="flex items-center mb-4">
              <div className="ml-4">
                <h2 className="text-lg font-semibold text-gray-900">Импорт данных</h2>
                <p className="text-sm text-gray-500">Загрузка проектов из CSV</p>
              </div>
            </div>
            <p className="mt-auto text-sm text-blue-600 font-medium">Перейти →</p>
          </div>
        </Link>
      </div>

      <div className="mt-8">
        <AdminTracesPanel />
      </div>

    </div>
  );
}
