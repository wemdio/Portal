'use client';

/**
 * Client dashboard — single-page command center.
 *
 * One layout, three states branched by data:
 *   - Returning + has unread replies: replies-needing-attention is the lede.
 *   - Returning + caught up: short "all calm" greeting + campaigns rows.
 *   - First-visit / mid-onboarding: greeting + onboarding checklist; campaigns
 *     section hides until onboarding completes.
 *
 * No hero panel, no gradient text, no rainbow side-stripes, no per-action
 * chromatic accents. Single slate accent + semantic status dots only.
 * Conforms to DESIGN.md §Components, §Do's-and-Don'ts, and the Single Slate /
 * No-White-Background / Material rules.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  ArrowRight,
  Loader2,
  Mail,
  MessageSquare,
  RefreshCw,
  Send,
} from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';
import { OnboardingChecklist } from '@/components/client/OnboardingChecklist';
import { AutoPipelineSummary } from '@/components/client/AutoPipelineSummary';
import type { ClientNavMode } from '@/lib/clientNav';

// ───────────────────────── types ─────────────────────────

interface CampaignRow {
  id: string;
  name: string;
  status: number | null;
  emails_sent_count: number | null;
  open_count: number | null;
  reply_count: number | null;
  new_leads_contacted_count: number | null;
  analytics_synced_at: string | null;
}

interface CampaignsResponse {
  total: number;
  campaigns: CampaignRow[];
  lastSyncedAt: string | null;
}

interface ReplyItem {
  id: string;
  campaign_id: string;
  campaign_name: string | null;
  lead_email: string;
  lead_name: string | null;
  company_name: string | null;
  reply_subject: string | null;
  reply_timestamp: string | null;
  is_unread?: boolean;
  is_lead?: boolean;
  thread_id?: string | null;
  email_id?: string | null;
  ai_interest_value?: number | null;
}

interface RepliesResponse {
  items: ReplyItem[];
  total: number;
  limit: number;
  offset: number;
}

interface OnboardingItem {
  id: 'brief' | 'preset' | 'first_base' | 'first_clean' | 'first_sequence' | 'first_launch';
  label: string;
  done: boolean;
  href: string | null;
  blocked_reason?: string;
}

interface OnboardingResponse {
  items: OnboardingItem[];
  complete: boolean;
  next_id: OnboardingItem['id'] | null;
}

// ───────────────────────── helpers ─────────────────────────

/** Russian plural — "1 ответ" / "2 ответа" / "5 ответов". */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Compact relative time in Russian — "5 мин назад", "2 ч назад", "3 дня назад". */
function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return 'только что';
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

/** Status int → human label + 6px semantic dot color. */
function statusInfo(status: number | null): { label: string; dot: string } {
  switch (status) {
    case 1:
      return { label: 'Активна', dot: 'var(--cp-green)' };
    case 2:
      return { label: 'Пауза', dot: 'var(--cp-amber)' };
    case 3:
      return { label: 'Завершена', dot: 'var(--cp-text-l)' };
    default:
      return { label: 'Подготовка', dot: 'var(--cp-text-l)' };
  }
}

function trimSubject(s: string | null, max = 60): string {
  if (!s) return '';
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1).trimEnd() + '…';
}

// ───────────────────────── page ─────────────────────────

export default function ClientDashboardPage() {
  const [campaigns, setCampaigns] = useState<CampaignRow[] | null>(null);
  const [replies, setReplies] = useState<ReplyItem[] | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingResponse | null>(null);
  // 'auto' клиенты — портал собирает кампании за них; онбординг скрываем,
  // CTA «Создать кампанию» меняется на блок AutoPipelineSummary.
  const [portalMode, setPortalMode] = useState<ClientNavMode>('manual');

  const [campaignsError, setCampaignsError] = useState('');
  const [repliesError, setRepliesError] = useState('');

  const [reloadKey, setReloadKey] = useState(0);
  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;

    setCampaignsError('');
    setRepliesError('');
    setCampaigns(null);
    setReplies(null);

    void (async () => {
      try {
        const data = await clientApiFetch<CampaignsResponse>('/campaigns');
        if (!cancelled) setCampaigns(data.campaigns ?? []);
      } catch (err) {
        if (cancelled) return;
        setCampaigns([]);
        setCampaignsError(
          err instanceof Error
            ? 'Не удалось загрузить кампании. Проверьте подключение и повторите.'
            : 'Не удалось загрузить кампании.',
        );
      }
    })();

    void (async () => {
      try {
        const data = await clientApiFetch<RepliesResponse>('/replies?limit=50');
        if (!cancelled) setReplies(data.items ?? []);
      } catch (err) {
        if (cancelled) return;
        setReplies([]);
        setRepliesError(
          err instanceof Error
            ? 'Не удалось загрузить ответы лидов.'
            : 'Не удалось загрузить ответы.',
        );
      }
    })();

    void (async () => {
      try {
        const data = await clientApiFetch<OnboardingResponse>('/onboarding/status');
        if (!cancelled) setOnboarding(data);
      } catch {
        // onboarding is graceful-fallback; absence simply hides the checklist
        if (!cancelled) setOnboarding(null);
      }
    })();

    void (async () => {
      try {
        const data = await clientApiFetch<{ mode?: ClientNavMode }>('/portal-mode');
        if (!cancelled && (data.mode === 'auto' || data.mode === 'manual')) {
          setPortalMode(data.mode);
        }
      } catch {
        // mode fetch failure → falls back to 'manual'; nothing breaks.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // ── derived state ──────────────────────────────────────

  const unreadReplies = useMemo(
    () => (replies ?? []).filter((r) => r.is_unread && !r.is_lead),
    [replies],
  );

  const totalUnread = unreadReplies.length;
  const ledeReplies = unreadReplies.slice(0, 3);

  const recentCampaigns = (campaigns ?? []).slice(0, 5);
  const hasAnyCampaigns = (campaigns ?? []).length > 0;
  const hasActiveCampaign = (campaigns ?? []).some((c) => c.status === 1);

  const onboardingComplete = onboarding?.complete === true;
  const showCampaignsSection = hasAnyCampaigns || onboardingComplete;

  // Editorial section numbering — pageLocal index, advanced by visible sections.
  const ledeVisible = totalUnread > 0;
  const campaignsNumber = ledeVisible ? '02' : '01';

  const stillLoading = campaigns === null || replies === null;

  // ── greeting copy (branches on data) ──────────────────

  const greeting = useMemo<string | null>(() => {
    if (stillLoading) return null;

    if (totalUnread > 0) {
      const word = plural(totalUnread, 'ответ', 'ответа', 'ответов');
      const verb = plural(totalUnread, 'ждёт', 'ждут', 'ждут');
      return `С возвращением. ${totalUnread} ${word} ${verb} вас.`;
    }

    if (hasActiveCampaign) {
      return 'С возвращением. Сегодня всё спокойно.';
    }

    if (onboarding && !onboarding.complete && onboarding.items?.length) {
      const next =
        onboarding.items.find((i) => i.id === onboarding.next_id && !i.done) ??
        onboarding.items.find((i) => !i.done);
      if (next) {
        const doneCount = onboarding.items.filter((i) => i.done).length;
        const verb = doneCount === 0 ? 'сделаем первый шаг' : 'сделаем следующий шаг';
        return `Здравствуйте. Давайте ${verb} — ${next.label.toLowerCase()}.`;
      }
    }

    return 'С возвращением.';
  }, [stillLoading, totalUnread, hasActiveCampaign, onboarding]);

  // ───────────────────────── render ─────────────────────────

  return (
    <div className="mx-auto max-w-5xl space-y-6 sm:space-y-8">
      {/* Greeting — single line, no hero container, no gradient */}
      <header>
        <p
          className="text-base sm:text-lg font-bold"
          style={{ color: greeting === null ? 'var(--cp-text-l)' : 'var(--cp-text)' }}
        >
          {greeting ?? 'Загружаем…'}
        </p>
      </header>

      {/* Lede: replies awaiting attention. Renders only when there's something. */}
      {totalUnread > 0 && (
        <section aria-labelledby="dash-attention-label">
          <h2 id="dash-attention-label" className="ds-eyebrow mb-3">
            01<span aria-hidden> → </span>Сегодня требуют внимания
          </h2>

          <div className="neu-card overflow-hidden">
            {ledeReplies.map((r, idx) => {
              const name = (r.lead_name?.trim() || r.lead_email).trim();
              const company = r.company_name?.trim();
              const subject = trimSubject(r.reply_subject, 64);
              const ago = relativeTime(r.reply_timestamp);
              return (
                <Link
                  key={r.id}
                  href={'/client/replies' as Route}
                  className="neu-row flex items-center gap-3 px-4 sm:px-5 py-3 sm:py-3.5 focus:outline-none focus-visible:ring-2"
                  style={
                    idx > 0
                      ? {
                          borderTop: '1px solid var(--cp-row-divider, rgba(180,173,164,0.18))',
                        }
                      : undefined
                  }
                >
                  <span
                    aria-hidden
                    className="ds-status-dot shrink-0"
                    style={{ background: 'var(--cp-amber)' }}
                  />
                  <MessageSquare
                    className="h-4 w-4 shrink-0"
                    style={{ color: 'var(--cp-paper-faint)' }}
                    aria-hidden
                  />
                  <div className="flex-1 min-w-0">
                    <p
                      className="text-sm font-bold truncate"
                      style={{ color: 'var(--cp-text)' }}
                    >
                      {name}
                      {company && (
                        <>
                          <span style={{ color: 'var(--cp-text-l)' }}> · </span>
                          <span style={{ color: 'var(--cp-text-m)', fontWeight: 600 }}>
                            {company}
                          </span>
                        </>
                      )}
                    </p>
                    {subject && (
                      <p
                        className="text-xs mt-0.5 truncate"
                        style={{ color: 'var(--cp-text-m)' }}
                      >
                        {subject}
                      </p>
                    )}
                  </div>
                  {ago && (
                    <span
                      className="text-[11px] whitespace-nowrap shrink-0 hidden sm:inline"
                      style={{ color: 'var(--cp-text-l)' }}
                    >
                      {ago}
                    </span>
                  )}
                  <span
                    className="text-xs font-semibold whitespace-nowrap shrink-0"
                    style={{ color: 'var(--cp-accent)' }}
                  >
                    Ответить
                  </span>
                  <ArrowRight
                    className="h-4 w-4 shrink-0"
                    style={{ color: 'var(--cp-text-l)' }}
                    aria-hidden
                  />
                </Link>
              );
            })}
          </div>

          {totalUnread > 3 && (
            <div className="mt-2 text-right">
              <Link
                href={'/client/replies' as Route}
                className="text-xs font-semibold inline-flex items-center gap-1"
                style={{ color: 'var(--cp-accent)' }}
              >
                Все {totalUnread} {plural(totalUnread, 'ответ', 'ответа', 'ответов')}
                <ArrowRight className="h-3 w-3" aria-hidden />
              </Link>
            </div>
          )}
        </section>
      )}

      {/* repliesError renders independently of totalUnread so the user always
          sees a hint when the replies fetch failed, even if the failure left
          `replies` as [] and the attention section is therefore hidden. */}
      {repliesError && (
        <p
          className="text-[11px]"
          style={{ color: 'var(--cp-text-l)' }}
        >
          Список ответов мог обновиться неполностью. Перезагрузите страницу, чтобы синхронизировать.
        </p>
      )}

      {/* Auto-pipeline summary — заменяет онбординг для клиентов в авто-режиме.
          Гарантированно невидим для manual-клиентов (компонент сам ничего не
          рендерит при enabled=false, но условие на режим даёт предсказуемость). */}
      {portalMode === 'auto' && <AutoPipelineSummary />}

      {/* Campaigns section — hidden for new clients until onboarding completes */}
      {showCampaignsSection && (
        <section aria-labelledby="dash-campaigns-label">
          <div className="flex items-center justify-between mb-3">
            <h2 id="dash-campaigns-label" className="ds-eyebrow">
              {campaignsNumber}<span aria-hidden> → </span>Кампании
            </h2>
            {hasAnyCampaigns && (
              <Link
                href={'/client' as Route}
                className="text-xs font-semibold inline-flex items-center gap-1"
                style={{ color: 'var(--cp-accent)' }}
              >
                Все кампании <ArrowRight className="h-3 w-3" aria-hidden />
              </Link>
            )}
          </div>

          {campaignsError && (
            <div
              className="neu-inset rounded-2xl px-4 py-3 text-sm flex items-center gap-3"
              role="alert"
            >
              <span className="flex-1" style={{ color: 'var(--cp-danger)' }}>
                {campaignsError}
              </span>
              <button
                type="button"
                onClick={retry}
                className="neu-pill inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold"
                style={{ color: 'var(--cp-text)' }}
              >
                <RefreshCw className="h-3 w-3" aria-hidden />
                Повторить
              </button>
            </div>
          )}

          {campaigns === null && !campaignsError && (
            <div className="neu-card flex items-center gap-3 px-5 py-6">
              <Loader2
                className="h-4 w-4 animate-spin"
                style={{ color: 'var(--cp-text-l)' }}
                aria-hidden
              />
              <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
                Загружаем кампании…
              </p>
            </div>
          )}

          {campaigns !== null && campaigns.length === 0 && !campaignsError && (
            <div className="neu-card px-5 py-8 sm:py-10 text-center">
              <Mail
                className="mx-auto h-8 w-8 mb-3"
                style={{ color: 'var(--cp-text-l)' }}
                aria-hidden
              />
              <p className="text-sm font-bold mb-1" style={{ color: 'var(--cp-text)' }}>
                Кампаний пока нет
              </p>
              {portalMode === 'auto' ? (
                <p className="text-xs" style={{ color: 'var(--cp-text-m)' }}>
                  Кампании собираются автоматически каждое утро в 07:00 МСК —
                  следите за разделом «Ответы».
                </p>
              ) : (
                <>
                  <p className="text-xs mb-4" style={{ color: 'var(--cp-text-m)' }}>
                    Когда вы запустите первую кампанию, она появится здесь.
                  </p>
                  <Link
                    href={'/client/launch' as Route}
                    className="neu-btn inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold"
                  >
                    <Send className="h-4 w-4" aria-hidden /> Создать кампанию
                  </Link>
                </>
              )}
            </div>
          )}

          {recentCampaigns.length > 0 && (
            <div className="neu-card overflow-hidden">
              {recentCampaigns.map((c, idx) => {
                const sent = Number(c.emails_sent_count ?? 0);
                const replied = Number(c.reply_count ?? 0);
                const contacted = Number(c.new_leads_contacted_count ?? 0);
                const replyRate = contacted > 0 ? (replied / contacted) * 100 : 0;
                const info = statusInfo(c.status);
                const rateColor =
                  replyRate < 0.5 ? 'var(--cp-danger)' : 'var(--cp-text)';
                const last = relativeTime(c.analytics_synced_at);
                return (
                  <Link
                    key={c.id}
                    href={`/client/campaigns/${c.id}` as Route}
                    className="neu-row flex items-center gap-3 px-4 sm:px-5 py-3 sm:py-3.5 focus:outline-none focus-visible:ring-2"
                    style={
                      idx > 0
                        ? {
                            borderTop:
                              '1px solid var(--cp-row-divider, rgba(180,173,164,0.18))',
                          }
                        : undefined
                    }
                  >
                    <span
                      aria-label={info.label}
                      title={info.label}
                      className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ background: info.dot }}
                    />
                    <div className="flex-1 min-w-0">
                      <p
                        className="text-sm font-bold truncate"
                        style={{ color: 'var(--cp-text)' }}
                      >
                        {c.name}
                      </p>
                      <p
                        className="text-[11px] mt-0.5 truncate"
                        style={{ color: 'var(--cp-text-m)' }}
                      >
                        {info.label} · {sent.toLocaleString('ru-RU')} отправлено
                        {replied > 0 && (
                          <>
                            {' · '}
                            <span style={{ color: rateColor, fontWeight: 600 }}>
                              {replyRate.toFixed(1)}% ответов
                            </span>
                          </>
                        )}
                        {last && <> · {last}</>}
                      </p>
                    </div>
                    <ArrowRight
                      className="h-4 w-4 shrink-0"
                      style={{ color: 'var(--cp-text-l)' }}
                      aria-hidden
                    />
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Onboarding checklist — only when incomplete. */}
      {/* Onboarding — скрываем для auto-режима: онбординг про брифы/базы/цепочки
          бессмыслен, когда пайплайн собирает кампании автоматически. Сверху
          страницы для таких клиентов стоит AutoPipelineSummary. */}
      {portalMode === 'manual' && onboarding && !onboarding.complete && <OnboardingChecklist />}
    </div>
  );
}
