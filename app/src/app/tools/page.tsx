import Link from 'next/link';
import type { Route } from 'next';
import { Database, Sparkles, Mail, Search, PhoneCall, AudioLines, Monitor } from 'lucide-react';

export default function ToolsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Инструменты</h1>
        <p className="text-sm text-gray-500">
          Набор утилит для работы с данными и процессами.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Link
          href={'/tools/done-for-you' as Route}
          className="group rounded-2xl border-2 border-blue-200 bg-gradient-to-br from-blue-50 to-white p-6 transition hover:shadow-md hover:border-blue-300"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-base font-semibold text-gray-900">Done For You База</p>
                <span className="px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-amber-100 text-amber-700 rounded">
                  В разработке
                </span>
              </div>
              <p className="text-sm text-gray-500">
                AI соберет, очистит и персонализирует базу автоматически по брифу.
              </p>
            </div>
            <Sparkles className="h-8 w-8 text-blue-500 group-hover:text-blue-600 transition-colors" />
          </div>
          <div className="mt-4 text-sm font-medium text-blue-600 group-hover:text-blue-700">
            Открыть →
          </div>
        </Link>
        <Link
          href={'/tools/ai-caller' as Route}
          className="group rounded-2xl border border-gray-200 bg-white p-6 transition hover:shadow-md"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-base font-semibold text-gray-900">AI Звонилка</p>
              <p className="text-sm text-gray-500">
                AI-ассистенты для обзвона: тестовые звонки, управление промптами и история.
              </p>
            </div>
            <PhoneCall className="h-8 w-8 text-gray-400 group-hover:text-blue-600 transition-colors" />
          </div>
          <div className="mt-4 text-sm font-medium text-blue-600 group-hover:text-blue-700">
            Открыть →
          </div>
        </Link>
        <Link
          href={'/tools/ai-caller-v2' as Route}
          className="group rounded-2xl border-2 border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-6 transition hover:shadow-md hover:border-emerald-300"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-base font-semibold text-gray-900">AI Звонилка v2</p>
                <span className="px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-emerald-100 text-emerald-700 rounded">
                  ElevenLabs
                </span>
              </div>
              <p className="text-sm text-gray-500">
                Естественный голос через ElevenLabs Conversational AI.
              </p>
            </div>
            <AudioLines className="h-8 w-8 text-emerald-500 group-hover:text-emerald-600 transition-colors" />
          </div>
          <div className="mt-4 text-sm font-medium text-emerald-600 group-hover:text-emerald-700">
            Открыть →
          </div>
        </Link>
        <Link
          href="/tools/databases"
          className="group rounded-2xl border border-gray-200 bg-white p-6 transition hover:shadow-md"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-base font-semibold text-gray-900">Работа с базами</p>
              <p className="text-sm text-gray-500">
                Табличный редактор с вкладками и копированием.
              </p>
            </div>
            <Database className="h-8 w-8 text-gray-400 group-hover:text-blue-600 transition-colors" />
          </div>
          <div className="mt-4 text-sm font-medium text-blue-600 group-hover:text-blue-700">
            Открыть →
          </div>
        </Link>
        <Link
          href="/parsers"
          className="group rounded-2xl border border-gray-200 bg-white p-6 transition hover:shadow-md"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-base font-semibold text-gray-900">Парсеры</p>
              <p className="text-sm text-gray-500">
                Набор парсеров для сбора данных, запусков и выгрузки результатов.
              </p>
            </div>
            <Search className="h-8 w-8 text-gray-400 group-hover:text-blue-600 transition-colors" />
          </div>
          <div className="mt-4 text-sm font-medium text-blue-600 group-hover:text-blue-700">
            Открыть →
          </div>
        </Link>

        <Link
          href={'/tools/email-sequence' as Route}
          className="group rounded-2xl border border-gray-200 bg-white p-6 transition hover:shadow-md"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-base font-semibold text-gray-900">Цепочки писем</p>
              <p className="text-sm text-gray-500">
                Генерация ресёрча по сегменту и цепочки холодных писем.
              </p>
            </div>
            <Mail className="h-8 w-8 text-gray-400 group-hover:text-blue-600 transition-colors" />
          </div>
          <div className="mt-4 text-sm font-medium text-blue-600 group-hover:text-blue-700">
            Открыть →
          </div>
        </Link>

        <div
          className="rounded-2xl border-2 border-violet-200 bg-gradient-to-br from-violet-50 to-white p-6 opacity-90"
          aria-disabled="true"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-base font-semibold text-gray-900">Удалённый рабочий стол</p>
                <span className="px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-amber-100 text-amber-700 rounded">
                  В разработке
                </span>
              </div>
              <p className="text-sm text-gray-500">
                Подключение к удалённому ПК через браузер с бронированием.
              </p>
            </div>
            <Monitor className="h-8 w-8 text-violet-400" />
          </div>
          <div className="mt-4 text-sm font-medium text-gray-400 cursor-not-allowed">
            Открыть →
          </div>
        </div>
      </div>
    </div>
  );
}
