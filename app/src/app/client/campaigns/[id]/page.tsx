'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import { ChevronLeft, Loader2, Mail, Clock } from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';
import type { Campaign, CampaignAnalytics, CampaignStepAnalytics, SequenceStep } from '@/lib/instantly/types';

function MetricCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="rounded-lg border border-zinc-100 bg-zinc-50/50 p-4">
      <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide">{label}</p>
      <p className="mt-1 text-xl font-bold text-zinc-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-zinc-400">{sub}</p>}
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
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (error && !campaign) {
    return (
      <div className="mx-auto max-w-4xl">
        <Link href={'/client' as Route} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 mb-4">
          <ChevronLeft className="h-3 w-3" /> Кампании
        </Link>
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
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
      <Link href={'/client' as Route} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 mb-4 transition-colors">
        <ChevronLeft className="h-3 w-3" /> Кампании
      </Link>

      <h1 className="text-xl font-bold text-zinc-900 mb-1">{campaign.name}</h1>
      <p className="text-xs text-zinc-400 mb-6">ID: {campaign.id}</p>

      <div className="flex gap-2 mb-6">
        {(['overview', 'steps'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-full px-4 py-1.5 text-xs font-medium transition-all ${
              tab === t ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
            }`}
          >
            {t === 'overview' ? 'Обзор' : 'Цепочка'}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 mb-6">
            <MetricCard label="Отправлено" value={sentCount} />
            <MetricCard label="Открытия" value={openCount} sub={`${openRate}%`} />
            <MetricCard label="Ответы" value={replyCount} sub={`${replyRate}%`} />
            <MetricCard label="Контактов" value={contactedCount} />
            <MetricCard label="Лидов" value={Number(analytics?.leads_count ?? 0)} />
            <MetricCard label="Bounce" value={bouncedCount} />
          </div>

          {steps.length > 0 && (
            <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
              <h3 className="px-4 py-3 text-sm font-semibold text-zinc-800 border-b border-zinc-100">Статистика по шагам</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-100 bg-zinc-50/50 text-left">
                      <th className="px-4 py-2 text-xs font-medium text-zinc-500">Шаг</th>
                      <th className="px-4 py-2 text-xs font-medium text-zinc-500 text-right">Отправлено</th>
                      <th className="px-4 py-2 text-xs font-medium text-zinc-500 text-right">Открытия</th>
                      <th className="px-4 py-2 text-xs font-medium text-zinc-500 text-right">Ответы</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-50">
                    {steps.map((s, i) => (
                      <tr key={i}>
                        <td className="px-4 py-2 text-zinc-700">
                          Step {s.step}{s.variant ? ` (var ${String.fromCharCode(65 + Number(s.variant))})` : ''}
                        </td>
                        <td className="px-4 py-2 text-right">{s.sent ?? 0}</td>
                        <td className="px-4 py-2 text-right">{s.unique_opened ?? s.opened ?? 0}</td>
                        <td className="px-4 py-2 text-right">{s.unique_replies ?? s.replies ?? 0}</td>
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
            <div className="rounded-xl border border-zinc-200 bg-white py-12 text-center">
              <Mail className="mx-auto h-8 w-8 text-zinc-300" />
              <p className="mt-3 text-sm text-zinc-500">Цепочка не настроена</p>
            </div>
          ) : (
            sequences.map((step, idx) => {
              const subject = step.subject ?? step.variants?.[0]?.subject ?? '';
              const body = stripHtml(step.body ?? step.variants?.[0]?.body);
              const waitDays = step.wait_days ?? (step.delay_unit === 'days' ? step.delay ?? null : null);
              return (
                <div key={idx} className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
                  <div className="px-4 py-3 border-b border-zinc-100 flex items-center gap-3">
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-100 text-xs font-bold text-zinc-600">
                      {idx + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      {subject && <p className="text-sm font-medium text-zinc-800 truncate">{subject}</p>}
                      {step.variants && step.variants.length > 1 && (
                        <p className="text-[10px] text-zinc-400">{step.variants.length} варианта</p>
                      )}
                    </div>
                    {waitDays != null && waitDays > 0 && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-zinc-400">
                        <Clock className="h-3 w-3" /> {waitDays}д
                      </span>
                    )}
                  </div>
                  {body && (
                    <div className="px-4 py-3">
                      <pre className="text-xs text-zinc-600 whitespace-pre-wrap font-sans leading-relaxed max-h-48 overflow-y-auto">
                        {body}
                      </pre>
                    </div>
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
