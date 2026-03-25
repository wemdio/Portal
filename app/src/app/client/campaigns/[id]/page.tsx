'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import { clientApiFetch } from '@/lib/clientFetcher';
import type { Campaign, CampaignAnalytics, CampaignStepAnalytics, SequenceStep } from '@/lib/instantly/types';

function MetricCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="neu-sm p-3 sm:p-4">
      <p className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>{label}</p>
      <p className="mt-1 sm:mt-1.5 text-lg sm:text-xl font-bold">{value}</p>
      {sub && <p className="mt-0.5 text-[10px] sm:text-xs" style={{ color: 'var(--cp-text-m)' }}>{sub}</p>}
    </div>
  );
}

function stripHtml(value?: string): string {
  if (!value) return '';
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

export default function ClientCampaignDetailPage() {
  const params = useParams<{ id: string }>();
  const campaignId = params.id;

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [analytics, setAnalytics] = useState<CampaignAnalytics | null>(null);
  const [steps, setSteps] = useState<CampaignStepAnalytics[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'overview' | 'steps'>('overview');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await clientApiFetch<{
        campaign: Campaign;
        analytics: CampaignAnalytics | null;
        steps: CampaignStepAnalytics[];
      }>(`/campaigns/${campaignId}`);
      setCampaign(data.campaign);
      setAnalytics(data.analytics);
      setSteps(data.steps ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <div className="neu-spinner animate-spin" />
      </div>
    );
  }

  if (error && !campaign) {
    return (
      <div className="mx-auto max-w-4xl">
        <Link href={'/client' as Route} className="inline-flex items-center gap-1 text-xs font-medium mb-4 transition-colors" style={{ color: 'var(--cp-text-m)' }}>
          ← Кампании
        </Link>
        <div className="neu-inset rounded-2xl px-5 py-4 text-sm font-medium" style={{ color: 'var(--cp-danger)' }}>{error}</div>
      </div>
    );
  }

  if (!campaign) return null;

  const sentCount = Number(analytics?.emails_sent_count ?? 0);
  const openCount = Number(analytics?.open_count ?? 0);
  const replyCount = Number(analytics?.reply_count ?? 0);
  const contactedCount = Number(analytics?.new_leads_contacted_count ?? 0);
  const bouncedCount = Number(analytics?.bounced_count ?? 0);
  const openRate = sentCount > 0 ? ((openCount / sentCount) * 100).toFixed(1) : '0';
  const replyRate = contactedCount > 0 ? ((replyCount / contactedCount) * 100).toFixed(1) : '0';

  const sequences: SequenceStep[] = (campaign.sequences ?? []).flatMap((s) => s.steps ?? []);

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href={'/client' as Route}
        className="inline-flex items-center gap-1 text-xs font-medium mb-5 transition-colors"
        style={{ color: 'var(--cp-text-m)' }}
        onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--cp-accent)')}
        onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--cp-text-m)')}
      >
        ← Кампании
      </Link>

      <h1 className="text-lg sm:text-xl font-extrabold mb-1 break-words">{campaign.name}</h1>
      <p className="text-[10px] sm:text-xs mb-4 sm:mb-6 truncate" style={{ color: 'var(--cp-text-l)' }}>ID: {campaign.id}</p>

      <div className="flex gap-2 mb-4 sm:mb-6">
        {(['overview', 'steps'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`neu-pill px-5 py-2 text-xs font-semibold ${tab === t ? 'active' : ''}`}
            style={tab !== t ? { color: 'var(--cp-text-m)' } : undefined}
          >
            {t === 'overview' ? 'Обзор' : 'Цепочка'}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-3 lg:grid-cols-4 mb-4 sm:mb-6">
            <MetricCard label="Отправлено" value={sentCount} />
            <MetricCard label="Открытия" value={openCount} sub={`${openRate}%`} />
            <MetricCard label="Ответы" value={replyCount} sub={`${replyRate}%`} />
            <MetricCard label="Контактов" value={contactedCount} />
            <MetricCard label="Лидов" value={Number(analytics?.leads_count ?? 0)} />
            <MetricCard label="Bounce" value={bouncedCount} />
          </div>

          {steps.length > 0 && (
            <div className="neu-card overflow-hidden">
              <h3 className="px-3 sm:px-5 py-3 sm:py-4 text-xs sm:text-sm font-bold" style={{ color: 'var(--cp-text-m)' }}>
                Статистика по шагам
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs sm:text-sm">
                  <thead>
                    <tr style={{ borderTop: '1px solid rgba(180,173,164,0.15)' }}>
                      <th className="px-3 sm:px-5 py-2.5 sm:py-3 text-left text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>Шаг</th>
                      <th className="px-3 sm:px-5 py-2.5 sm:py-3 text-right text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>Отпр.</th>
                      <th className="px-3 sm:px-5 py-2.5 sm:py-3 text-right text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>Откр.</th>
                      <th className="px-3 sm:px-5 py-2.5 sm:py-3 text-right text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>Отв.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {steps.map((s, i) => (
                      <tr key={i} className="neu-row" style={{ borderTop: '1px solid rgba(180,173,164,0.15)' }}>
                        <td className="px-3 sm:px-5 py-2.5 sm:py-3" style={{ color: 'var(--cp-text-m)' }}>
                          Step {s.step}{s.variant ? ` (${String.fromCharCode(65 + Number(s.variant))})` : ''}
                        </td>
                        <td className="px-3 sm:px-5 py-2.5 sm:py-3 text-right" style={{ color: 'var(--cp-text-m)' }}>{s.sent ?? 0}</td>
                        <td className="px-3 sm:px-5 py-2.5 sm:py-3 text-right" style={{ color: 'var(--cp-text-m)' }}>{s.unique_opened ?? s.opened ?? 0}</td>
                        <td className="px-3 sm:px-5 py-2.5 sm:py-3 text-right" style={{ color: 'var(--cp-text-m)' }}>{s.unique_replies ?? s.replies ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'steps' && (
        <div className="space-y-4">
          {sequences.length === 0 ? (
            <div className="neu-card py-14 text-center">
              <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>Цепочка не настроена</p>
            </div>
          ) : (
            sequences.map((step, idx) => {
              const subject = step.subject ?? step.variants?.[0]?.subject ?? '';
              const body = stripHtml(step.body ?? step.variants?.[0]?.body);
              const waitDays = step.wait_days ?? (step.delay_unit === 'days' ? step.delay ?? null : null);
              return (
                <div key={idx} className="neu-sm overflow-hidden">
                  <div className="px-3 sm:px-5 py-3 sm:py-4 flex items-center gap-2.5 sm:gap-3">
                    <div className="neu-well flex h-7 w-7 sm:h-8 sm:w-8 items-center justify-center text-[10px] sm:text-xs font-bold shrink-0" style={{ color: 'var(--cp-accent)' }}>
                      {idx + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      {subject && <p className="text-xs sm:text-sm font-semibold truncate">{subject}</p>}
                      {step.variants && step.variants.length > 1 && (
                        <p className="text-[10px]" style={{ color: 'var(--cp-text-l)' }}>{step.variants.length} варианта</p>
                      )}
                    </div>
                    {waitDays != null && waitDays > 0 && (
                      <span className="text-[10px] sm:text-[11px] font-medium shrink-0" style={{ color: 'var(--cp-text-l)' }}>
                        {waitDays}д
                      </span>
                    )}
                  </div>
                  {body && (
                    <>
                      <hr className="neu-divider mx-3 sm:mx-5" />
                      <div className="px-3 sm:px-5 py-3 sm:py-4">
                        <pre className="text-[11px] sm:text-xs whitespace-pre-wrap font-sans leading-relaxed max-h-48 overflow-y-auto" style={{ color: 'var(--cp-text-m)' }}>
                          {body}
                        </pre>
                      </div>
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
