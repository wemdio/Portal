'use client';

import type {
  VeLegacyProjectDetail,
  VeLegacyProjectSummary,
} from '@/lib/verticalEngineV2/types.legacy';

function text(value: unknown, fallback = '—'): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function formatDate(value: unknown): string {
  if (typeof value !== 'string' || !value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
}

function recordId(row: Record<string, unknown>, index: number): string {
  return typeof row.id === 'string' ? row.id : String(index);
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="text-2xl font-semibold text-slate-950">{value}</div>
      <div className="mt-1 text-xs text-slate-500">{label}</div>
    </div>
  );
}

function EmptyArchive() {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center">
      <p className="text-sm font-semibold text-slate-800">Архив пока пуст</p>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-slate-500">
        В архив попадают только проекты, которые администратор вручную подтвердил как
        внутренние. ENG-проекты сюда автоматически не добавляются.
      </p>
    </div>
  );
}

export function LegacyArchivePanel({
  projects,
  detail,
  detailLoading,
  onSelect,
  onBack,
}: {
  projects: VeLegacyProjectSummary[];
  detail: VeLegacyProjectDetail | null;
  detailLoading: boolean;
  onSelect: (id: string) => void;
  onBack: () => void;
}) {
  if (detailLoading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-sm text-slate-500">
        Загружаем read-only снимок старого прогона…
      </div>
    );
  }

  if (!detail) {
    if (projects.length === 0) return <EmptyArchive />;
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {projects.map((project) => (
          <button
            key={project.id}
            type="button"
            onClick={() => onSelect(project.id)}
            className="rounded-2xl border border-slate-200 bg-white p-5 text-left transition hover:border-slate-300 hover:shadow-sm motion-safe:hover:-translate-y-0.5 motion-safe:active:scale-[0.99]"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-950">
                  {project.name}
                </p>
                <p className="mt-1 truncate text-xs text-slate-500">
                  {project.website_url}
                </p>
              </div>
              <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700">
                legacy
              </span>
            </div>
            <div className="mt-5 flex items-center justify-between text-xs text-slate-500">
              <span>{project.status}</span>
              <span>{formatDate(project.created_at)}</span>
            </div>
          </button>
        ))}
      </div>
    );
  }

  const project = detail.project;
  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={onBack}
        className="text-sm font-medium text-slate-600 hover:text-slate-950"
      >
        ← Назад к архиву
      </button>

      <section className="rounded-2xl border border-amber-200 bg-amber-50/70 p-5">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-950">
                {text(project.name, 'Legacy-проект')}
              </h2>
              <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-700">
                Только чтение
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-600">{text(project.website_url)}</p>
          </div>
          <div className="text-xs leading-5 text-slate-500">
            <div>Создан: {formatDate(project.created_at)}</div>
            <div>Проверен: {formatDate(detail.verification.verified_at)}</div>
          </div>
        </div>
        {detail.verification.review_notes ? (
          <p className="mt-4 border-t border-amber-200 pt-4 text-sm text-slate-600">
            {detail.verification.review_notes}
          </p>
        ) : null}
      </section>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Гипотез" value={detail.hypotheses.length} />
        <Stat label="Вертикалей" value={detail.verticals.length} />
        <Stat label="Цепочек" value={detail.chains.length} />
        <Stat label="Баз" value={detail.bases.length} />
        <Stat label="Шаблонов" value={detail.templates.length} />
        <Stat label="Джоб" value={detail.jobs.length} />
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-slate-950">Вертикали</h3>
        {detail.verticals.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">Вертикалей нет.</p>
        ) : (
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {detail.verticals.map((vertical, index) => (
              <div
                key={recordId(vertical, index)}
                className="rounded-xl border border-slate-200 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-semibold text-slate-900">
                    {text(vertical.name)}
                  </p>
                  <span className="text-xs font-medium text-slate-500">
                    {typeof vertical.potential_pct === 'number'
                      ? `${vertical.potential_pct}%`
                      : ''}
                  </span>
                </div>
                {vertical.summary ? (
                  <p className="mt-2 text-xs leading-5 text-slate-500">
                    {String(vertical.summary)}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-slate-950">Гипотезы</h3>
        {detail.hypotheses.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">Гипотез нет.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {detail.hypotheses.map((hypothesis, index) => (
              <div
                key={recordId(hypothesis, index)}
                className="rounded-xl border border-slate-200 px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    T{String(hypothesis.tier ?? '—')}
                  </span>
                  <p className="text-sm font-medium text-slate-900">
                    {text(hypothesis.title)}
                  </p>
                  <span className="ml-auto text-xs text-slate-500">
                    {typeof hypothesis.potential_pct === 'number'
                      ? `${hypothesis.potential_pct}%`
                      : ''}
                  </span>
                </div>
                {hypothesis.description ? (
                  <p className="mt-2 text-xs leading-5 text-slate-500">
                    {String(hypothesis.description)}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-slate-950">Письма и шаблоны</h3>
        {detail.chains.length === 0 && detail.templates.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">Материалов нет.</p>
        ) : (
          <div className="mt-4 space-y-4">
            {detail.chains.map((chain, index) => {
              const letters = Array.isArray(chain.letters)
                ? (chain.letters as Array<Record<string, unknown>>)
                : [];
              return (
                <div key={recordId(chain, index)} className="rounded-xl bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Цепочка · {text(chain.language, 'язык не указан')} · {letters.length}{' '}
                    писем
                  </p>
                  <div className="mt-3 space-y-2">
                    {letters.map((letter, letterIndex) => (
                      <div
                        key={`${recordId(chain, index)}-${letterIndex}`}
                        className="rounded-lg border border-slate-200 bg-white p-3"
                      >
                        <p className="text-xs font-semibold text-slate-800">
                          {text(letter.subject, `Письмо ${letterIndex + 1}`)}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-slate-500">
                          {text(letter.body)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            {detail.templates.map((template, index) => (
              <div
                key={recordId(template, index)}
                className="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-3 text-sm"
              >
                <span className="font-medium text-slate-800">
                  Шаблон {index + 1}
                </span>
                <span className="text-xs text-slate-500">{text(template.status)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-slate-950">Базы</h3>
        {detail.bases.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">Баз нет.</p>
        ) : (
          <div className="mt-4 divide-y divide-slate-100">
            {detail.bases.map((base, index) => (
              <div
                key={recordId(base, index)}
                className="flex flex-wrap items-center gap-x-5 gap-y-1 py-3 text-sm"
              >
                <span className="font-medium text-slate-800">
                  {text(base.filename, `База ${index + 1}`)}
                </span>
                <span className="text-xs text-slate-500">
                  {String(base.row_count ?? 0)} строк
                </span>
                <span className="ml-auto text-xs text-slate-500">
                  {text(base.status)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
