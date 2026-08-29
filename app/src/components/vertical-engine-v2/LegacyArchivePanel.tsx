'use client';

import { ArrowLeft } from 'lucide-react';
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
    <div className="ve2-stat">
      <div className="ve2-stat-v">{value}</div>
      <div className="ve2-stat-k">{label}</div>
    </div>
  );
}

function EmptyArchive() {
  return (
    <div className="ve2-empty px-6 py-12">
      <p className="ve2-h3">Архив пока пуст</p>
      <p className="ve2-mut mx-auto mt-2 max-w-lg leading-6">
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
      <div className="ve2-card ve2-mut p-8">
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
            className="ve2-card ve2-card-h p-5 text-left transition"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="ve2-h3 truncate">
                  {project.name}
                </p>
                <p className="ve2-faint mt-1 truncate">
                  {project.website_url}
                </p>
              </div>
              <span className="ve2-tag">legacy</span>
            </div>
            <div className="ve2-mut mt-5 flex items-center justify-between text-xs">
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
        className="ve2-b-quiet inline-flex items-center gap-1.5 text-sm"
      >
        <ArrowLeft aria-hidden className="h-4 w-4" />
        Назад к архиву
      </button>

      <section className="ve2-nt ve2-nt-warn p-5">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="ve2-h2">
                {text(project.name, 'Legacy-проект')}
              </h2>
              <span className="ve2-tag">Только чтение</span>
            </div>
            <p className="ve2-mut mt-1 text-sm">{text(project.website_url)}</p>
          </div>
          <div className="ve2-faint leading-5">
            <div>Создан: {formatDate(project.created_at)}</div>
            <div>Проверен: {formatDate(detail.verification.verified_at)}</div>
          </div>
        </div>
        {detail.verification.review_notes ? (
          <p className="ve2-mut ve2-div mt-4 border-t pt-4 text-sm">
            {detail.verification.review_notes}
          </p>
        ) : null}
      </section>

      <div className="ve2-stats">
        <Stat label="Гипотез" value={detail.hypotheses.length} />
        <Stat label="Вертикалей" value={detail.verticals.length} />
        <Stat label="Цепочек" value={detail.chains.length} />
        <Stat label="Баз" value={detail.bases.length} />
        <Stat label="Шаблонов" value={detail.templates.length} />
        <Stat label="Джоб" value={detail.jobs.length} />
      </div>

      <section className="ve2-card p-5">
        <h3 className="ve2-h3">Вертикали</h3>
        {detail.verticals.length === 0 ? (
          <p className="ve2-mut mt-3">Вертикалей нет.</p>
        ) : (
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {detail.verticals.map((vertical, index) => (
              <div
                key={recordId(vertical, index)}
                className="ve2-card p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="ve2-h4">
                    {text(vertical.name)}
                  </p>
                  <span className="ve2-pct ve2-pct-lo">
                    {typeof vertical.potential_pct === 'number'
                      ? `${vertical.potential_pct}%`
                      : ''}
                  </span>
                </div>
                {vertical.summary ? (
                  <p className="ve2-mut mt-2 text-xs leading-5">
                    {String(vertical.summary)}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="ve2-card p-5">
        <h3 className="ve2-h3">Гипотезы</h3>
        {detail.hypotheses.length === 0 ? (
          <p className="ve2-mut mt-3">Гипотез нет.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {detail.hypotheses.map((hypothesis, index) => (
              <div
                key={recordId(hypothesis, index)}
                className="ve2-card px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="ve2-tier">
                    T{String(hypothesis.tier ?? '—')}
                  </span>
                  <p className="ve2-h4">
                    {text(hypothesis.title)}
                  </p>
                  <span className="ve2-pct ve2-pct-lo ml-auto">
                    {typeof hypothesis.potential_pct === 'number'
                      ? `${hypothesis.potential_pct}%`
                      : ''}
                  </span>
                </div>
                {hypothesis.description ? (
                  <p className="ve2-mut mt-2 text-xs leading-5">
                    {String(hypothesis.description)}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="ve2-card p-5">
        <h3 className="ve2-h3">Письма и шаблоны</h3>
        {detail.chains.length === 0 && detail.templates.length === 0 ? (
          <p className="ve2-mut mt-3">Материалов нет.</p>
        ) : (
          <div className="mt-4 space-y-4">
            {detail.chains.map((chain, index) => {
              const letters = Array.isArray(chain.letters)
                ? (chain.letters as Array<Record<string, unknown>>)
                : [];
              return (
                <div key={recordId(chain, index)} className="ve2-soft p-4">
                  <p className="ve2-eb">
                    Цепочка · {text(chain.language, 'язык не указан')} · {letters.length}{' '}
                    писем
                  </p>
                  <div className="mt-3 space-y-2">
                    {letters.map((letter, letterIndex) => (
                      <div
                        key={`${recordId(chain, index)}-${letterIndex}`}
                        className="ve2-card p-3"
                      >
                        <p className="ve2-h4 text-xs">
                          {text(letter.subject, `Письмо ${letterIndex + 1}`)}
                        </p>
                        <p className="ve2-mut mt-1 whitespace-pre-wrap text-xs leading-5">
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
                className="ve2-card flex items-center justify-between px-4 py-3 text-sm"
              >
                <span className="ve2-h4">
                  Шаблон {index + 1}
                </span>
                <span className="ve2-mut text-xs">{text(template.status)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="ve2-card p-5">
        <h3 className="ve2-h3">Базы</h3>
        {detail.bases.length === 0 ? (
          <p className="ve2-mut mt-3">Баз нет.</p>
        ) : (
          <div className="mt-4">
            {detail.bases.map((base, index) => (
              <div
                key={recordId(base, index)}
                className="ve2-div flex flex-wrap items-center gap-x-5 gap-y-1 border-t py-3 text-sm first:border-t-0"
              >
                <span className="ve2-h4">
                  {text(base.filename, `База ${index + 1}`)}
                </span>
                <span className="ve2-faint">
                  {String(base.row_count ?? 0)} строк
                </span>
                <span className="ve2-mut ml-auto text-xs">
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
