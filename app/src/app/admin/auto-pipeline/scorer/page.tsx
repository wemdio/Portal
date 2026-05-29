'use client';

/**
 * Admin страница для управления фоновым BoB scorer'ом.
 *
 * Доступна только админам/директорам. Показывает full controls — toggle,
 * reset progress, технические параметры. Клиентская версия (на странице
 * /client/auto-pipeline/setup) показывает тот же компонент без admin-кнопок.
 */

import Link from 'next/link';
import { useUser } from '@/lib/UserProvider';
import { isAdmin } from '@/lib/roles';
import { BackgroundScorerPanel } from '@/components/auto-pipeline/BackgroundScorerPanel';

export default function AdminBackgroundScorerPage() {
  const { userRole } = useUser();

  if (!isAdmin(userRole)) {
    return (
      <div className="max-w-3xl mx-auto py-10 px-4">
        <div className="rounded-lg border border-red-200 bg-red-50 p-6">
          <h2 className="text-lg font-semibold text-red-800">Доступ запрещён</h2>
          <p className="mt-1 text-sm text-red-600">
            Только администраторы могут управлять фоновым сборщиком.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto py-10 px-4">
      <div className="mb-6">
        <Link
          href="/admin/users"
          className="text-sm font-medium text-blue-600 hover:text-blue-700"
        >
          ← Назад к админке
        </Link>
      </div>

      <header className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">
          Фоновый сборщик баз
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          Постоянно прогоняет компании из «базы баз» (~485 тыс. — все компании
          с сайтом) через Mailganer-скоринг. Найденные активные домены попадают
          в общий кэш и используются ежедневным прогоном auto-pipeline вместо
          случайной выборки.
        </p>
      </header>

      <BackgroundScorerPanel isAdmin={true} />

      <section className="mt-6 rounded-xl border border-gray-200 bg-gray-50 p-5 text-sm text-gray-700 space-y-2">
        <h3 className="font-semibold text-gray-900">Как это работает</h3>
        <ol className="list-decimal list-inside space-y-1 marker:text-gray-400">
          <li>
            Воркер работает 24/7 в отдельном Docker-контейнере. После
            перезапуска сервера автоматически продолжает с того места, где
            остановился.
          </li>
          <li>
            Каждый «тик» — берёт {`{batch_size}`} компаний из базы баз, скорит
            через Mailganer, сохраняет результат в общий кэш.
          </li>
          <li>
            Когда ежедневный auto-pipeline cron нужен — он берёт готовые активные
            домены из этого кэша вместо повторного скоринга. Экономит ~2 часа на
            каждом прогоне.
          </li>
          <li>
            Score 0 тоже сохраняются (около 90% компаний) — чтобы их не скорить
            повторно. Активные (score &gt; 0) видны в счётчике слева.
          </li>
        </ol>
      </section>
    </div>
  );
}
