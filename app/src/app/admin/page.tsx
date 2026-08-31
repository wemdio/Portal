'use client';

import Link from 'next/link';
import { Users, FileText, Database, Activity, Settings, Globe, Gauge, KeyRound } from 'lucide-react';
import { useIsTma } from '@/lib/useIsTma';
import { useUser } from '@/lib/UserProvider';

export default function AdminPage() {
  const isTma = useIsTma();
  const { locale } = useUser();

  const cardClass =
    'bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md hover:border-blue-300 transition-all group ' +
  (isTma ? 'p-5' : 'p-8');

  return (
    <div className={`max-w-6xl mx-auto px-4 ${isTma ? 'py-6 text-sm leading-relaxed' : 'py-10'}`}>
      <h1 className={`${isTma ? 'text-xl' : 'text-3xl'} font-bold mb-6 sm:mb-8 text-gray-900`}>
        {locale === 'en' ? 'Admin panel' : 'Админ панель'}
      </h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <Link href="/admin/users" className={cardClass}>
          <div className="flex h-full flex-col">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">{locale === 'en' ? 'User management' : 'Управление пользователями'}</h2>
                <p className="text-sm text-gray-500">{locale === 'en' ? 'Create users and assign roles' : 'Создание пользователей и назначение ролей'}</p>
              </div>
              <Users className="h-6 w-6 text-blue-600/80" />
            </div>
            <p className="mt-auto text-sm font-medium text-blue-600">{locale === 'en' ? 'Open →' : 'Перейти →'}</p>
          </div>
        </Link>

        <Link href="/admin/reglament" className={cardClass}>
          <div className="flex h-full flex-col">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">{locale === 'en' ? 'Regulations' : 'Регламенты'}</h2>
                <p className="text-sm text-gray-500">{locale === 'en' ? 'Create and edit documents' : 'Создание и редактирование документов'}</p>
              </div>
              <FileText className="h-6 w-6 text-blue-600/80" />
            </div>
            <p className="mt-auto text-sm font-medium text-blue-600">{locale === 'en' ? 'Open →' : 'Перейти →'}</p>
          </div>
        </Link>

        <Link href="/admin/import" className={cardClass}>
          <div className="flex h-full flex-col">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">{locale === 'en' ? 'Data import' : 'Импорт данных'}</h2>
                <p className="text-sm text-gray-500">{locale === 'en' ? 'Upload projects from CSV' : 'Загрузка проектов из CSV'}</p>
              </div>
              <Database className="h-6 w-6 text-blue-600/80" />
            </div>
            <p className="mt-auto text-sm font-medium text-blue-600">{locale === 'en' ? 'Open →' : 'Перейти →'}</p>
          </div>
        </Link>

        <Link href="/admin/traces" className={cardClass}>
          <div className="flex h-full flex-col">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">{locale === 'en' ? 'Task traces' : 'Трассировки задач'}</h2>
                <p className="text-sm text-gray-500">{locale === 'en' ? 'Task execution tree and logs' : 'Дерево выполнения задач и логи'}</p>
              </div>
              <Activity className="h-6 w-6 text-blue-600/80" />
            </div>
            <p className="mt-auto text-sm font-medium text-blue-600">{locale === 'en' ? 'Open →' : 'Перейти →'}</p>
          </div>
        </Link>

        <Link href="/admin/domains" className={cardClass}>
          <div className="flex h-full flex-col">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">{locale === 'en' ? 'Domain monitoring' : 'Мониторинг доменов'}</h2>
                <p className="text-sm text-gray-500">
                  {locale === 'en'
                    ? 'Domain statuses and expiration dates on Reg.ru.'
                    : 'Статус и сроки истечения доменов на Reg.ru.'}
                </p>
              </div>
              <Globe className="h-6 w-6 text-blue-600/80" />
            </div>
            <p className="mt-auto text-sm font-medium text-blue-600">{locale === 'en' ? 'Open →' : 'Перейти →'}</p>
          </div>
        </Link>

        <Link href="/admin/bench-keys" className={cardClass}>
          <div className="flex h-full flex-col">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">{locale === 'en' ? 'API keys' : 'Ключи API'}</h2>
                <p className="text-sm text-gray-500">
                  {locale === 'en'
                    ? 'External access to parsers and the base constructor: issue and revoke keys.'
                    : 'Внешний доступ к парсерам и конструктору баз: выдать и отозвать ключи.'}
                </p>
              </div>
              <KeyRound className="h-6 w-6 text-blue-600/80" />
            </div>
            <p className="mt-auto text-sm font-medium text-blue-600">{locale === 'en' ? 'Open →' : 'Перейти →'}</p>
          </div>
        </Link>

        <Link href="/admin/env" className={cardClass}>
          <div className="flex h-full flex-col">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">{locale === 'en' ? 'Environment variables' : 'Переменные окружения'}</h2>
                <p className="text-sm text-gray-500">
                  {locale === 'en'
                    ? 'View and edit the server .env file.'
                    : 'Просмотр и редактирование .env файла на сервере.'}
                </p>
              </div>
              <Settings className="h-6 w-6 text-blue-600/80" />
            </div>
            <p className="mt-auto text-sm font-medium text-blue-600">{locale === 'en' ? 'Open →' : 'Перейти →'}</p>
          </div>
        </Link>

        <Link href="/admin/auto-pipeline/scorer" className={cardClass}>
          <div className="flex h-full flex-col">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">
                  {locale === 'en' ? 'Auto-pipeline scorer' : 'Фоновый сборщик баз'}
                </h2>
                <p className="text-sm text-gray-500">
                  {locale === 'en'
                    ? 'Background Mailganer scoring of BoB domains; start/stop and progress.'
                    : 'Фоновый Mailganer-скоринг доменов из «базы баз», прогресс и управление.'}
                </p>
              </div>
              <Gauge className="h-6 w-6 text-blue-600/80" />
            </div>
            <p className="mt-auto text-sm font-medium text-blue-600">{locale === 'en' ? 'Open →' : 'Перейти →'}</p>
          </div>
        </Link>
      </div>
    </div>
  );
}
