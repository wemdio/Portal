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
  badge?: string;
}

const SOURCES: readonly SourceCard[] = [
  {
    href: '/client/companies-search',
    label: 'B2B-поиск компаний',
    description: 'По ОКВЭД, регионам, выручке. Российские компании с реквизитами.',
    badge: 'Россия',
  },
  {
    href: '/client/parsers?tab=hh',
    label: 'HH.ru',
    description: 'Парсинг компаний по их вакансиям — отличный сигнал найма.',
  },
  {
    href: '/client/parsers?tab=search',
    label: 'Поисковая выдача',
    description: 'Сбор сайтов по любым ключевым запросам через Google/Яндекс.',
  },
  {
    href: '/client/parsers?tab=yandexmaps',
    label: 'Яндекс.Карты',
    description: 'Локальный бизнес: рестораны, клиники, магазины с адресами.',
  },
  {
    href: '/client/base-constructor',
    label: 'Загрузить файл',
    description: 'Уже есть CSV/XLSX? Загрузите — мы очистим и обогатим.',
    badge: 'Свой файл',
  },
];

export default function ClientBuildHubPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-8 sm:space-y-10">
      {/* ── Header: no hero gradient, just editorial typography ───────── */}
      <header>
        <h1
          className="text-xl sm:text-2xl font-bold m-0"
          style={{ color: 'var(--cp-paper)' }}
        >
          Базы
        </h1>
        <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
          Соберите контакты из любого источника и подготовьте базу к рассылке.
          Это два шага: сначала источник, затем очистка и обогащение.
        </p>
      </header>

      {/* ── Step 1: Sources ─────────────────────────────────────────────── */}
      <section>
        <p className="ds-eyebrow mb-2">
          01<span aria-hidden> → </span>Откуда взять контакты
        </p>
        <h2 className="text-base sm:text-lg font-bold m-0 mb-1" style={{ color: 'var(--cp-paper)' }}>
          Источники сбора
        </h2>
        <p className="text-xs sm:text-sm mb-4" style={{ color: 'var(--cp-paper-mute)' }}>
          Выберите источник или загрузите свой файл
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          {SOURCES.map((s, idx) => {
            const num = String(idx + 1).padStart(2, '0');
            return (
              <Link
                key={s.href}
                href={s.href as Route}
                className="neu-card ds-card-pressable group flex items-start gap-4 p-5"
              >
                <span
                  className="ds-mono text-xs shrink-0 mt-0.5"
                  style={{ color: 'var(--cp-paper-faint)' }}
                  aria-hidden
                >
                  {num}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <h3 className="text-sm font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
                      {s.label}
                    </h3>
                    {s.badge && (
                      <span
                        className="ds-mono text-[10px] px-1.5 py-0.5 rounded"
                        style={{
                          background: 'var(--cp-surface-elev)',
                          color: 'var(--cp-paper-mute)',
                        }}
                      >
                        {s.badge}
                      </span>
                    )}
                  </div>
                  <p
                    className="text-xs leading-snug m-0"
                    style={{ color: 'var(--cp-paper-mute)' }}
                  >
                    {s.description}
                  </p>
                </div>

                <ArrowRight
                  className="h-4 w-4 shrink-0 mt-1 transition-transform group-hover:translate-x-0.5"
                  style={{ color: 'var(--cp-paper-faint)' }}
                  aria-hidden
                />
              </Link>
            );
          })}
        </div>
      </section>

      {/* ── Step 2: Clean & Enrich ──────────────────────────────────────── */}
      <section>
        <p className="ds-eyebrow mb-2">
          02<span aria-hidden> → </span>Очистить и обогатить
        </p>
        <h2 className="text-base sm:text-lg font-bold m-0 mb-1" style={{ color: 'var(--cp-paper)' }}>
          Конструктор баз
        </h2>
        <p className="text-xs sm:text-sm mb-4" style={{ color: 'var(--cp-paper-mute)' }}>
          Найти email, проверить сайты, оценить ЦА и написать персонализацию
        </p>

        <Link
          href={'/client/base-constructor' as Route}
          className="neu-card ds-card-pressable group flex items-start gap-4 p-5 sm:p-6"
        >
          <div className="flex-1 min-w-0">
            <p className="text-xs sm:text-sm leading-snug m-0" style={{ color: 'var(--cp-paper-mute)' }}>
              Дедупликация, очистка названий, поиск email через сайты компаний,
              SMTP-валидация, AI-описания, оценка ЦА и персонализация под бриф.
              До 10 000 строк за один проход.
            </p>
          </div>
          <ArrowRight
            className="h-5 w-5 shrink-0 mt-1 transition-transform group-hover:translate-x-0.5"
            style={{ color: 'var(--cp-paper-faint)' }}
            aria-hidden
          />
        </Link>
      </section>

    </div>
  );
}
