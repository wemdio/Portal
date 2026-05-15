'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Route } from 'next';
import {
  Send, Mail, ArrowRight, Loader2,
} from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';
import { OnboardingChecklist } from '@/components/client/OnboardingChecklist';

interface CampaignRow {
  id: string;
  name: string;
  status: number | null;
  emails_sent_count: number | null;
  reply_count: number | null;
}

interface CampaignsResponse {
  total: number;
  campaigns: CampaignRow[];
}

interface QuickAction {
  href: string;
  label: string;
  description: string;
  primary?: boolean;
}

const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    href: '/client/brief',
    label: 'Заполнить бриф',
    description: 'AI-инструменты используют его для лучших результатов',
  },
  {
    href: '/client/build',
    label: 'Подготовить базу',
    description: 'Собрать контакты из источников и очистить под рассылку',
  },
  {
    href: '/client/parsers?tab=email-sequence',
    label: 'Цепочки писем',
    description: 'AI-генерация холодных писем под сегмент',
  },
  {
    href: '/client/launch',
    label: 'Создать кампанию',
    description: 'Загрузить базу, написать цепочку и запустить',
    primary: true,
  },
];

function formatStatus(status: number | null): string {
  switch (status) {
    case 1: return 'Активна';
    case 2: return 'Пауза';
    case 3: return 'Завершена';
    default: return '—';
  }
}

export default function ClientDashboardPage() {
  const [campaigns, setCampaigns] = useState<CampaignRow[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await clientApiFetch<CampaignsResponse>('/campaigns');
        if (!cancelled) setCampaigns(data.campaigns ?? []);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Ошибка загрузки');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const recentCampaigns = (campaigns ?? []).slice(0, 5);

  return (
    <div className="mx-auto max-w-5xl space-y-6 sm:space-y-8">
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <header>
        <h1 className="text-2xl sm:text-3xl font-extrabold" style={{ color: 'var(--cp-text)' }}>
          Дашборд
        </h1>
        <p className="mt-2 text-sm sm:text-base" style={{ color: 'var(--cp-text-m)' }}>
          Здесь начинается ваш email-аутрич. Пройдите чеклист справа — за шесть шагов
          вы запустите первую кампанию.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_minmax(320px,420px)] gap-5 sm:gap-6">
        {/* ── Quick actions ────────────────────────────────────────── */}
        <section>
          <h2
            className="text-[10px] font-bold uppercase tracking-[0.12em] mb-3"
            style={{ color: 'var(--cp-text-l)' }}
          >
            Быстрые действия
          </h2>
          <div className="space-y-2.5">
            {QUICK_ACTIONS.map((action) => {
              return (
                <Link
                  key={action.href}
                  href={action.href as Route}
                  className={`neu-row flex items-center gap-3 sm:gap-4 px-4 py-3.5 rounded-2xl ${
                    action.primary ? 'neu-card' : 'neu-sm'
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <p
                      className="text-sm font-bold"
                      style={{ color: 'var(--cp-text)' }}
                    >
                      {action.label}
                    </p>
                    <p
                      className="text-xs mt-0.5"
                      style={{ color: 'var(--cp-text-m)' }}
                    >
                      {action.description}
                    </p>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0" style={{ color: 'var(--cp-text-l)' }} />
                </Link>
              );
            })}
          </div>
        </section>

        {/* ── Onboarding checklist ─────────────────────────────────── */}
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <OnboardingChecklist />
        </aside>
      </div>

      {/* ── Last campaigns ───────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2
            className="text-[10px] font-bold uppercase tracking-[0.12em]"
            style={{ color: 'var(--cp-text-l)' }}
          >
            Последние кампании
          </h2>
          {campaigns !== null && campaigns.length > 0 && (
            <Link
              href={'/client' as Route}
              className="text-xs font-semibold inline-flex items-center gap-1"
              style={{ color: 'var(--cp-accent)' }}
            >
              Все кампании <ArrowRight className="h-3 w-3" />
            </Link>
          )}
        </div>

        {error && (
          <div className="neu-inset rounded-2xl px-4 py-3 text-sm" style={{ color: 'var(--cp-danger)' }}>
            {error}
          </div>
        )}

        {campaigns === null && !error && (
          <div className="neu-card flex items-center gap-3 px-5 py-6">
            <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--cp-text-l)' }} />
            <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
              Загрузка кампаний…
            </p>
          </div>
        )}

        {campaigns !== null && campaigns.length === 0 && !error && (
          <div className="neu-card px-5 py-8 sm:py-10 text-center">
            <Mail className="mx-auto h-8 w-8 mb-3" style={{ color: 'var(--cp-text-l)' }} />
            <p className="text-sm font-bold mb-1" style={{ color: 'var(--cp-text)' }}>
              Кампаний пока нет
            </p>
            <p className="text-xs mb-4" style={{ color: 'var(--cp-text-m)' }}>
              Когда вы запустите первую кампанию, она появится здесь
            </p>
            <Link
              href={'/client/launch' as Route}
              className="neu-btn inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold"
            >
              <Send className="h-4 w-4" /> Создать кампанию
            </Link>
          </div>
        )}

        {recentCampaigns.length > 0 && (
          <div className="neu-card overflow-hidden">
            {recentCampaigns.map((c, idx) => {
              const sent = Number(c.emails_sent_count ?? 0);
              const replied = Number(c.reply_count ?? 0);
              return (
                <Link
                  key={c.id}
                  href={`/client/campaigns/${c.id}` as Route}
                  className="neu-row flex items-center gap-3 px-4 sm:px-5 py-3 sm:py-3.5"
                  style={idx > 0 ? { borderTop: '1px solid rgba(180,173,164,0.15)' } : undefined}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold truncate" style={{ color: 'var(--cp-text)' }}>
                      {c.name}
                    </p>
                    <p className="text-[11px] mt-0.5" style={{ color: 'var(--cp-text-m)' }}>
                      {formatStatus(c.status)} · {sent.toLocaleString('ru-RU')} sent · {replied} reply
                    </p>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0" style={{ color: 'var(--cp-text-l)' }} />
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
