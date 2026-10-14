'use client';

/**
 * Мелкие UI-примитивы клиентского ENG-кабинета: статус-тег, спиннер, карточка.
 * Хром — по DESIGN.md («Decisive Editorial Dark»): EngBadge — это status-tag
 * (6px dot + uppercase mono-tag, цвет только как данные), EngCard — ds-card.
 * Тексты компонентов кабинета — английские.
 */

import { Loader2 } from 'lucide-react';

export type EngTone = 'neutral' | 'accent' | 'green' | 'amber' | 'red';

/** Цвета dot/текста status-tag по тонам; только токены, никаких fill-карточек. */
const TONE_COLORS: Record<EngTone, { dot: string; text: string }> = {
  // quiet-вариант DESIGN.md — единственный, где dot и текст разного цвета.
  neutral: { dot: 'var(--cp-grey)', text: 'var(--cp-paper-mute)' },
  accent: { dot: 'var(--cp-paper)', text: 'var(--cp-paper)' },
  green: { dot: 'var(--cp-green)', text: 'var(--cp-green)' },
  amber: { dot: 'var(--cp-amber)', text: 'var(--cp-amber)' },
  red: { dot: 'var(--cp-red)', text: 'var(--cp-red)' },
};

/**
 * Клиентские подписи СЫРЫХ статусов he_* — словарь кабинета вместо значений
 * колонок. Бейджи мастера печатают статус как есть (`label={project.status}`,
 * `label={b.status}`, `template: ${template.status}`, `label={hypothesis.status}`
 * — шаги 1, 2, 4, 5, шапка мастера и список проектов), поэтому перевод стоит в
 * ЕДИНСТВЕННОМ компоненте бейджа (EngBadge ниже): любое место, где сырой статус
 * доезжает до бейджа, — нынешнее или будущее, — получает подпись, а не enum.
 *
 * Ключи — ровно значения enum'ов (types.ts), строчными, целиком: ни подписи
 * мастера с заглавной буквы («Ready to send», «Failed» у ящиков), ни фразы
 * («launched (paused)», «template: letters need rewriting») с ними не
 * совпадают и проходят как есть. Одно слово у разных сущностей значит одно и
 * то же, кроме `draft`, — у шаблона он приходит только с префиксом
 * «template: » (свой словарь ниже), голым — только у проекта.
 *
 * Каждая подпись правдива для любой строки с этим статусом:
 *  - `failed` → «stopped»: базу 'failed' пишут и сбой стадии, и ОБА
 *    cancel-роута (отмена отличается только строкой причины), поэтому
 *    «failed» про отменённую базу было неправдой; у проекта 'failed' пишут
 *    research-стадии — «stopped» верно и там, причину печатает «Last error»;
 *  - `draft` (проект) → «idle»: так стоит и новый проект до старта research, и
 *    проект после отмены research (cancel-роут возвращает его в 'draft');
 *    «not started» про второй случай было бы неправдой;
 *  - `researched` → «research done»; `proposed` (гипотеза) → «suggested»: ни
 *    принятия, ни отказа по ней ещё нет;
 *  - шаблон (CHECK колонки: 'draft' | 'ready' | 'failed'): стадия template
 *    пишет строку сразу 'ready' (stages/template.ts), 'draft' — лишь дефолт
 *    колонки, и ни он, ни 'failed' не значат «ещё строится». Поэтому `draft` →
 *    «not ready», а не «being built»; `failed` → «stopped», как у базы.
 */
const STATUS_LABELS: ReadonlyMap<string, string> = new Map([
  // he_projects.status
  ['draft', 'idle'],
  ['researching', 'researching'],
  ['researched', 'research done'],
  ['failed', 'stopped'],
  // he_bases.status ('failed' — выше)
  ['uploaded', 'uploaded'],
  ['collecting', 'collecting'],
  // Только пока анализ идёт: 'analyzing'-база без идущего анализа приходит в
  // бейдж как «analysis stopped» (EngBaseStatusBadge ниже).
  ['analyzing', 'analyzing'],
  ['analyzed', 'analyzed'],
  // he_hypotheses.status
  ['proposed', 'suggested'],
  ['accepted', 'accepted'],
  ['rejected', 'rejected'],
]);

/** he_templates.status — приходит в бейдж как «template: <status>». */
const TEMPLATE_STATUS_LABELS: ReadonlyMap<string, string> = new Map([
  ['draft', 'not ready'],
  ['ready', 'ready'],
  ['failed', 'stopped'],
]);

const TEMPLATE_STATUS_RE = /^template: ([a-z_]+)$/;

/** Подпись бейджа: сырой статус → слово кабинета; всё остальное — как есть. */
function engStatusLabel(label: string): string {
  const own = STATUS_LABELS.get(label);
  if (own !== undefined) return own;
  const template = TEMPLATE_STATUS_RE.exec(label);
  const templateLabel = template ? TEMPLATE_STATUS_LABELS.get(template[1]) : undefined;
  return templateLabel !== undefined ? `template: ${templateLabel}` : label;
}

export function EngBadge({ label, tone = 'neutral' }: { label: string; tone?: EngTone }) {
  const color = TONE_COLORS[tone];
  return (
    <span className="ds-status-tag" style={{ color: color.text }}>
      <span className="ds-status-dot" style={{ background: color.dot }} />
      {engStatusLabel(label)}
    </span>
  );
}

export function EngSpinner({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return <Loader2 className={`${className} animate-spin`} style={{ color: 'var(--cp-paper-mute)' }} />;
}

export function EngCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`ds-card p-4 sm:p-5 ${className}`}>{children}</div>;
}

export function EngEyebrow({ children }: { children: React.ReactNode }) {
  return <h3 className="ds-eyebrow mb-2">{children}</h3>;
}

/** Дата/время коротко (en-US — кабинет англоязычный). */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Тон бейджа для статуса проекта HE. */
export function projectStatusTone(status: string | undefined): EngTone {
  switch (status) {
    case 'researched':
      return 'green';
    case 'researching':
      return 'amber';
    case 'failed':
      return 'red';
    default:
      return 'neutral';
  }
}

/** Тон бейджа для статуса базы HE. */
export function baseStatusTone(status: string | undefined): EngTone {
  switch (status) {
    case 'analyzed':
      return 'green';
    case 'collecting':
    case 'analyzing':
      return 'amber';
    case 'failed':
      return 'red';
    default:
      return 'neutral';
  }
}

/**
 * Анализ 'analyzing'-базы НЕ идёт. Финальный фейл base_analyze базу не трогает
 * (она так и остаётся 'analyzing'), поэтому статус на этот вопрос не отвечает, и
 * бейдж «analyzing» про такую базу был неправдой. Ответ — СЕРВЕРА: признак
 * `analysis_live` деталки (GET /eng/projects/[id]) считается общим предикатом
 * isAnalyzingBaseLive — активная джоба на её base_id или окно постановки
 * ANALYZING_ORPHAN_GRACE_MS, — тем же, что у Command Center и «Launch».
 * Нет ключа (живость не прочитана) — не «остановлен»: анализ читается идущим.
 *
 * Одно правило на бейдж (EngBaseStatusBadge) и на фразу шага 3 про
 * остановленный анализ, чтобы они не расходились.
 */
export function engBaseAnalysisStopped(base: { status?: string; analysis_live?: boolean }): boolean {
  return base.status === 'analyzing' && base.analysis_live === false;
}

/**
 * Бейдж статуса базы: у 'analyzing'-базы, чей анализ не идёт
 * (engBaseAnalysisStopped), — «analysis stopped» янтарём (верно и про сбой, и
 * про отмену); иначе — статус через словарь EngBadge.
 */
export function EngBaseStatusBadge({ base }: { base: { status: string; analysis_live?: boolean } }) {
  return engBaseAnalysisStopped(base) ? (
    <EngBadge label="analysis stopped" tone="amber" />
  ) : (
    <EngBadge label={base.status} tone={baseStatusTone(base.status)} />
  );
}

/** Тон бейджа для статуса гипотезы HE. */
export function hypothesisStatusTone(status: string | undefined): EngTone {
  switch (status) {
    case 'accepted':
      return 'green';
    case 'rejected':
      return 'red';
    default:
      return 'neutral';
  }
}
