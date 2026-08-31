'use client';

import { ArrowLeft, ArrowRight } from 'lucide-react';
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
      <div className="ve2-panel ve2-mut p-8" role="status">
        Загружаем read-only снимок старого прогона…
      </div>
    );
  }

  if (!detail) {
    if (projects.length === 0) return <EmptyArchive />;
    return (
      <section className="ve2-sec" aria-labelledby="legacy-archive-title">
        <div className="ve2-sec-head">
          <div>
            <h2 id="legacy-archive-title" className="ve2-eb">
              01 → Архив legacy-прогонов
            </h2>
            <p className="ve2-mut mt-1.5 max-w-3xl">
              Сюда попадают только проекты, вручную подтверждённые как внутренние.
              ENG-проекты не добавляются автоматически.
            </p>
          </div>
          <span className="ve2-faint">{projects.length}</span>
        </div>
        <div className="ve2-rows">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              onClick={() => onSelect(project.id)}
              className="ve2-row flex-wrap"
            >
              <span className="min-w-0 flex-1">
                <span className="ve2-h3 block truncate">{project.name}</span>
                <span className="ve2-faint mt-0.5 block truncate">
                  {project.website_url}
                </span>
              </span>
              <span className="ve2-faint shrink-0">{project.status}</span>
              <span className="ve2-faint shrink-0">{formatDate(project.created_at)}</span>
              <span className="ve2-tag shrink-0">legacy</span>
              <ArrowRight aria-hidden className="ve2-faint h-4 w-4 shrink-0" />
            </button>
          ))}
        </div>
      </section>
    );
  }

  const project = detail.project;
  return (
    <section className="space-y-5" aria-labelledby="legacy-detail-title">
      <button
        type="button"
        onClick={onBack}
        className="ve2-b-quiet inline-flex items-center gap-1.5 text-sm"
      >
        <ArrowLeft aria-hidden className="h-4 w-4" />
        Назад к архиву
      </button>

      <header>
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="legacy-detail-title" className="ve2-h2">
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
          <p className="ve2-mut mt-3 max-w-[64ch] text-sm">
            {detail.verification.review_notes}
          </p>
        ) : null}
      </header>

      <div className="ve2-stats">
        <Stat label="Гипотез" value={detail.hypotheses.length} />
        <Stat label="Вертикалей" value={detail.verticals.length} />
        <Stat label="Цепочек" value={detail.chains.length} />
        <Stat label="Баз" value={detail.bases.length} />
        <Stat label="Шаблонов" value={detail.templates.length} />
        <Stat label="Джоб" value={detail.jobs.length} />
      </div>

      <section aria-labelledby="legacy-verticals-title">
        <h3 id="legacy-verticals-title" className="ve2-eb">02 → Вертикали</h3>
        {detail.verticals.length === 0 ? (
          <p className="ve2-mut mt-3">Вертикалей нет.</p>
        ) : (
          <div className="ve2-rows mt-2.5">
            {detail.verticals.map((vertical, index) => (
              <div
                key={recordId(vertical, index)}
                className="ve2-row ve2-row-static"
              >
                <div className="min-w-0 flex-1">
                  <p className="ve2-h4">{text(vertical.name)}</p>
                  {vertical.summary ? (
                    <p className="ve2-mut mt-2 text-xs leading-5">
                      {String(vertical.summary)}
                    </p>
                  ) : null}
                </div>
                <span className="ve2-pct ve2-pct-lo shrink-0">
                  {typeof vertical.potential_pct === 'number'
                    ? `${vertical.potential_pct}%`
                    : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="legacy-hypotheses-title">
        <h3 id="legacy-hypotheses-title" className="ve2-eb">03 → Гипотезы</h3>
        {detail.hypotheses.length === 0 ? (
          <p className="ve2-mut mt-3">Гипотез нет.</p>
        ) : (
          <div className="ve2-rows mt-2.5">
            {detail.hypotheses.map((hypothesis, index) => (
              <div
                key={recordId(hypothesis, index)}
                className="ve2-row ve2-row-static flex-wrap"
              >
                <span className="ve2-tier">T{String(hypothesis.tier ?? '—')}</span>
                <div className="min-w-0 flex-1">
                  <p className="ve2-h4">{text(hypothesis.title)}</p>
                  {hypothesis.description ? (
                    <p className="ve2-mut mt-2 text-xs leading-5">
                      {String(hypothesis.description)}
                    </p>
                  ) : null}
                </div>
                <span className="ve2-pct ve2-pct-lo shrink-0">
                  {typeof hypothesis.potential_pct === 'number'
                    ? `${hypothesis.potential_pct}%`
                    : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="legacy-materials-title">
        <h3 id="legacy-materials-title" className="ve2-eb">04 → Письма и шаблоны</h3>
        {detail.chains.length === 0 && detail.templates.length === 0 ? (
          <p className="ve2-mut mt-3">Материалов нет.</p>
        ) : (
          <div className="mt-2.5 space-y-4">
            {detail.chains.map((chain, index) => {
              const letters = Array.isArray(chain.letters)
                ? (chain.letters as Array<Record<string, unknown>>)
                : [];
              return (
                <div key={recordId(chain, index)} className="ve2-panel px-5 pt-4">
                  <p className="ve2-eb">
                    Цепочка · {text(chain.language, 'язык не указан')} · {letters.length}{' '}
                    писем
                  </p>
                  <ol className="mt-1 list-none">
                    {letters.map((letter, letterIndex) => (
                      <li
                        key={`${recordId(chain, index)}-${letterIndex}`}
                        className="ve2-letter"
                      >
                        <p className="ve2-letter-subject">
                          {text(letter.subject, `Письмо ${letterIndex + 1}`)}
                        </p>
                        <p className="ve2-letter-body">
                          {text(letter.body)}
                        </p>
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })}
            {detail.templates.length > 0 ? (
              <div className="ve2-rows">
                {detail.templates.map((template, index) => (
                  <div
                    key={recordId(template, index)}
                    className="ve2-row ve2-row-static"
                  >
                    <span className="ve2-h4 flex-1">Шаблон {index + 1}</span>
                    <span className="ve2-faint">{text(template.status)}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </section>

      <section aria-labelledby="legacy-bases-title">
        <h3 id="legacy-bases-title" className="ve2-eb">05 → Базы</h3>
        {detail.bases.length === 0 ? (
          <p className="ve2-mut mt-3">Баз нет.</p>
        ) : (
          <div className="ve2-rows mt-2.5">
            {detail.bases.map((base, index) => (
              <div
                key={recordId(base, index)}
                className="ve2-row ve2-row-static flex-wrap"
              >
                <span className="ve2-h4 min-w-0 flex-1">
                  {text(base.filename, `База ${index + 1}`)}
                </span>
                <span className="ve2-faint">
                  {String(base.row_count ?? 0)} строк
                </span>
                <span className="ve2-faint shrink-0">
                  {text(base.status)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
