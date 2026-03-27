import Link from 'next/link';
import type { Route } from 'next';
import { GUIDE_SECTIONS } from '@/lib/guide/guideIndex';

export default function GuideIndexPage() {
  const totalPages = GUIDE_SECTIONS.reduce((sum, section) => sum + section.pages.length, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6">
      <header className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-bold text-gray-900">Гайд по порталу</h1>
        <p className="mt-2 text-sm text-gray-600">
          Полное руководство по пользовательскому контуру портала (без админки):
          вкладки Header, инструменты, кнопки и end-to-end пайплайны.
        </p>
        <div className="mt-4 inline-flex rounded-lg bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
          Разделов: {GUIDE_SECTIONS.length} · Подразделов: {totalPages}
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-2">
        {GUIDE_SECTIONS.map((section) => (
          <Link
            key={section.slug}
            href={`/guide/${section.slug}` as Route}
            className="group rounded-2xl border border-gray-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md"
            prefetch={false}
          >
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-lg font-semibold text-gray-900">{section.title}</h2>
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                {section.pages.length}
              </span>
            </div>
            <p className="mt-2 text-sm text-gray-600">{section.summary}</p>
            <p className="mt-4 text-sm font-medium text-blue-600 group-hover:text-blue-700">Открыть раздел →</p>
          </Link>
        ))}
      </section>
    </div>
  );
}
