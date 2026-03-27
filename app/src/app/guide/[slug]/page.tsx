import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Route } from 'next';
import { GUIDE_SECTIONS, getGuideSection } from '@/lib/guide/guideIndex';

type Params = { slug: string };

export function generateStaticParams(): Params[] {
  return GUIDE_SECTIONS.map((section) => ({ slug: section.slug }));
}

export default async function GuideSectionPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;
  const section = getGuideSection(slug);
  if (!section) notFound();

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6">
      <header className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <Link href={'/guide' as Route} className="text-sm font-medium text-blue-600 hover:text-blue-700" prefetch={false}>
          ← К оглавлению гайда
        </Link>
        <h1 className="mt-3 text-2xl font-bold text-gray-900">{section.title}</h1>
        <p className="mt-2 text-sm text-gray-600">{section.summary}</p>
      </header>

      <div className="space-y-4">
        {section.pages.map((page) => (
          <article key={`${page.title}-${page.route}`} className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-semibold text-gray-900">{page.title}</h2>
              <code className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-700">{page.route}</code>
            </div>

            <p className="mt-2 text-sm text-gray-700">{page.purpose}</p>

            {page.subchapters && page.subchapters.length > 0 && (
              <section className="mt-4">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Подглавы раздела</h3>
                <div className="mt-2 space-y-3">
                  {page.subchapters.map((subchapter) => (
                    <div key={`${subchapter.title}-${subchapter.route ?? 'local'}`} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-gray-900">{subchapter.title}</p>
                        {subchapter.route && (
                          <code className="rounded bg-white px-1.5 py-0.5 text-[11px] text-gray-600">{subchapter.route}</code>
                        )}
                      </div>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-700">
                        {subchapter.details.map((detail) => (
                          <li key={detail}>{detail}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="mt-4">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Что есть на экране</h3>
              <ul className="mt-2 space-y-1 text-sm text-gray-700">
                {page.controls.map((control) => (
                  <li key={control.name}>
                    <span className="font-medium text-gray-900">{control.name}:</span> {control.description}
                  </li>
                ))}
              </ul>
            </section>

            <section className="mt-4">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Пайплайн работы</h3>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-gray-700">
                {page.pipeline.map((step) => (
                  <li key={step.title}>
                    <span className="font-medium text-gray-900">{step.title}:</span> {step.description}
                  </li>
                ))}
              </ol>
            </section>

            <section className="mt-4 grid gap-4 md:grid-cols-2">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Состояния интерфейса</h3>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-700">
                  {page.states.map((state) => (
                    <li key={state}>{state}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Типовые ошибки</h3>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-700">
                  {page.typicalIssues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            </section>
          </article>
        ))}
      </div>
    </div>
  );
}
