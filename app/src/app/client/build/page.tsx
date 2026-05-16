'use client';

/**
 * Phase 4 consolidation hub.
 *
 * Replaces three sidebar items («Собрать базу», «Парсеры», «Очистить базу»)
 * with a single «Базы» entry that opens this page. The page itself is a
 * directory: it explains the workflow and links to the existing tool routes
 * (companies-search, parsers, base-constructor) so the underlying URLs and
 * page modules don't change — only navigation gets cleaner.
 *
 * Two phases of base preparation, surfaced explicitly:
 *   1. Источники сбора — five cards (B2B-поиск / HH / Поиск / Я.Карты /
 *      Загрузить файл). Each links to the relevant existing tool.
 *   2. Очистить и обогатить — single CTA into Base Constructor.
 *
 * No business logic here — this is a wayfinding surface.
 */

import Link from 'next/link';
import type { Route } from 'next';
import { ArrowRight } from 'lucide-react';

interface SourceCard {
  href: string;
  label: string;
  description: string;
  color: string;
  badge?: string;
}

const SOURCES: readonly SourceCard[] = [
  {
    href: '/client/companies-search',
    label: 'B2B-поиск компаний',
    description: 'По ОКВЭД, регионам, выручке. Российские компании с реквизитами.',
    color: '#3B82F6',
    badge: 'Россия',
  },
  {
    href: '/client/parsers?tab=hh',
    label: 'HH.ru',
    description: 'Парсинг компаний по их вакансиям — отличный сигнал найма.',
    color: '#6366F1',
  },
  {
    href: '/client/parsers?tab=search',
    label: 'Поисковая выдача',
    description: 'Сбор сайтов по любым ключевым запросам через Google/Яндекс.',
    color: '#8B5CF6',
  },
  {
    href: '/client/parsers?tab=yandexmaps',
    label: 'Яндекс.Карты',
    description: 'Локальный бизнес: рестораны, клиники, магазины с адресами.',
    color: '#F43F5E',
  },
  {
    href: '/client/base-constructor',
    label: 'Загрузить файл',
    description: 'Уже есть CSV/XLSX? Загрузите — мы очистим и обогатим.',
    color: '#F59E0B',
    badge: 'Свой файл',
  },
];

export default function ClientBuildHubPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-8 sm:space-y-10">
      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <header
        className="neu-card relative overflow-hidden p-6 sm:p-8"
        style={{ background: 'linear-gradient(135deg, rgba(59,130,246,0.06), rgba(139,92,246,0.05))' }}
      >
        <h1 className="text-2xl sm:text-3xl font-extrabold" style={{ color: 'var(--cp-text)' }}>
          Базы
        </h1>
        <p className="mt-2 text-sm sm:text-base" style={{ color: 'var(--cp-text-m)' }}>
          Соберите контакты из любого источника и подготовьте базу к рассылке.
          Это два шага: сначала источник, затем очистка и обогащение.
        </p>
      </header>

      {/* ── Step 1: Sources ─────────────────────────────────────────────── */}
      <section>
        <div className="flex items-baseline gap-3 mb-4">
          <span
            className="inline-flex items-center justify-center h-7 w-7 rounded-full text-[12px] font-bold shrink-0"
            style={{ background: 'linear-gradient(135deg, #3B82F6, #6366F1)', color: '#fff' }}
          >
            1
          </span>
          <div className="min-w-0">
            <h2 className="text-base sm:text-lg font-bold" style={{ color: 'var(--cp-text)' }}>
              Откуда взять контакты
            </h2>
            <p className="text-xs sm:text-sm" style={{ color: 'var(--cp-text-m)' }}>
              Выберите источник или загрузите свой файл
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          {SOURCES.map((s) => (
            <Link
              key={s.href}
              href={s.href as Route}
              className="neu-card group flex items-start gap-4 p-5 transition-all"
              style={{ borderLeft: `3px solid ${s.color}` }}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <h3 className="text-sm font-bold" style={{ color: 'var(--cp-text)' }}>
                    {s.label}
                  </h3>
                  {s.badge && (
                    <span
                      className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                      style={{ background: `${s.color}20`, color: s.color }}
                    >
                      {s.badge}
                    </span>
                  )}
                </div>
                <p className="text-xs leading-snug" style={{ color: 'var(--cp-text-m)' }}>
                  {s.description}
                </p>
              </div>

              <ArrowRight
                className="h-4 w-4 shrink-0 mt-1 transition-transform group-hover:translate-x-0.5"
                style={{ color: 'var(--cp-text-l)' }}
              />
            </Link>
          ))}
        </div>
      </section>

      {/* ── Step 2: Clean & Enrich ──────────────────────────────────────── */}
      <section>
        <div className="flex items-baseline gap-3 mb-4">
          <span
            className="inline-flex items-center justify-center h-7 w-7 rounded-full text-[12px] font-bold shrink-0"
            style={{ background: 'linear-gradient(135deg, #10B981, #059669)', color: '#fff' }}
          >
            2
          </span>
          <div className="min-w-0">
            <h2 className="text-base sm:text-lg font-bold" style={{ color: 'var(--cp-text)' }}>
              Очистить и обогатить
            </h2>
            <p className="text-xs sm:text-sm" style={{ color: 'var(--cp-text-m)' }}>
              Найти email, проверить сайты, оценить ЦА и написать персонализацию
            </p>
          </div>
        </div>

        <Link
          href={'/client/base-constructor' as Route}
          className="neu-card group flex items-start gap-4 p-5 sm:p-6 transition-all"
          style={{ borderLeft: '3px solid #10B981' }}
        >
          <div className="flex-1 min-w-0">
            <h3 className="text-sm sm:text-base font-bold mb-1" style={{ color: 'var(--cp-text)' }}>
              Конструктор баз
            </h3>
            <p className="text-xs sm:text-sm leading-snug" style={{ color: 'var(--cp-text-m)' }}>
              Дедупликация, очистка названий, поиск email через сайты компаний,
              SMTP-валидация, AI-описания, оценка ЦА и персонализация под бриф.
              До 10 000 строк за один проход.
            </p>
          </div>
          <ArrowRight
            className="h-5 w-5 shrink-0 mt-1 transition-transform group-hover:translate-x-0.5"
            style={{ color: 'var(--cp-text-l)' }}
          />
        </Link>
      </section>

      {/* ── Tip ────────────────────────────────────────────────────────── */}
      <aside
        className="neu-inset rounded-2xl px-4 py-3 sm:px-5 sm:py-4 text-xs sm:text-sm"
        style={{ color: 'var(--cp-text-m)', borderLeft: '3px solid #F59E0B' }}
      >
        <strong style={{ color: 'var(--cp-text)' }}>Совет.</strong>{' '}
        Один источник можно совмещать с другим — например, собрать список из B2B-поиска,
        затем добавить компании из Яндекс.Карт, и пропустить всё вместе через Конструктор.
      </aside>
    </div>
  );
}
