'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import {
  ChevronLeft, ChevronRight, Loader2, Play, Pause, ExternalLink, Save,
  Mail, Clock, Settings, Search, Users, Download, Trash2,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { instantlyFetch } from '@/lib/instantly/fetcher';
import type { Campaign, CampaignAnalytics, CampaignStepAnalytics, CustomTag, SequenceStep, Lead, PaginatedResponse } from '@/lib/instantly/types';
import { CampaignStatus, CampaignStatusLabels } from '@/lib/instantly/types';

const INTEREST_LABELS: Record<number, { label: string; cls: string }> = {
  0: { label: 'Не обработан', cls: 'bg-zinc-100 text-zinc-600' },
  1: { label: 'Заинтересован', cls: 'bg-emerald-50 text-emerald-700' },
  [-1]: { label: 'Не заинтересован', cls: 'bg-red-50 text-red-700' },
  [-2]: { label: 'Ответ получен', cls: 'bg-blue-50 text-blue-700' },
  [-3]: { label: 'Неверный контакт', cls: 'bg-orange-50 text-orange-700' },
};

function statusBadgeClass(status: number): string {
  switch (status) {
    case CampaignStatus.Active: return 'bg-emerald-50 text-emerald-700';
    case CampaignStatus.Paused: return 'bg-amber-50 text-amber-700';
    case CampaignStatus.Completed: return 'bg-blue-50 text-blue-700';
    case CampaignStatus.Draft: return 'bg-zinc-100 text-zinc-600';
    default: return 'bg-red-50 text-red-700';
  }
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between py-2.5">
      <span className="text-xs text-zinc-500">{label}</span>
      <span className="text-sm font-medium text-zinc-800 text-right max-w-[60%]">{value}</span>
    </div>
  );
}

function MetricCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="rounded-lg border border-zinc-100 bg-zinc-50/50 p-4">
      <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide">{label}</p>
      <p className="mt-1 text-xl font-bold text-zinc-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-zinc-400">{sub}</p>}
    </div>
  );
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtmlForPreview(value?: string): string {
  if (!value) return '';

  return decodeHtmlEntities(
    value
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
      .replace(/<p[^>]*>/gi, '')
      .replace(/<\/p>/gi, '')
      .replace(/<[^>]+>/g, ''),
  ).trim();
}

function getStepDisplay(step: SequenceStep) {
  const primaryVariant = step.variants?.[0];
  const subject = step.subject ?? primaryVariant?.subject ?? '';
  const body = stripHtmlForPreview(step.body ?? primaryVariant?.body);
  const waitDays = step.wait_days ?? (step.delay_unit === 'days' ? step.delay ?? null : null);

  return {
    subject,
    body,
    waitDays,
    variantsCount: step.variants?.length ?? 0,
  };
}

export default function CampaignDetailPage() {
  const params = useParams<{ id: string }>();
  const campaignId = params.id;

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [analytics, setAnalytics] = useState<CampaignAnalytics | null>(null);
  const [steps, setSteps] = useState<CampaignStepAnalytics[]>([]);
  const [allTags, setAllTags] = useState<CustomTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'overview' | 'steps' | 'leads' | 'settings'>('overview');

  const [leads, setLeads] = useState<Lead[]>([]);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [leadsHasMore, setLeadsHasMore] = useState(false);
  const [leadsAfter, setLeadsAfter] = useState<string | undefined>();
  const [leadsSearch, setLeadsSearch] = useState('');

  const [editName, setEditName] = useState('');
  const [editDailyLimit, setEditDailyLimit] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [c, a, s, tags] = await Promise.all([
        instantlyFetch<Campaign>(`/campaigns/${campaignId}`),
        instantlyFetch<CampaignAnalytics[] | { data: CampaignAnalytics[] }>(
          `/analytics?type=campaigns&campaign_id=${campaignId}`,
        ).catch(() => []),
        instantlyFetch<CampaignStepAnalytics[] | { data: CampaignStepAnalytics[] }>(
          `/analytics?type=steps&campaign_id=${campaignId}`,
        ).catch((err) => {
          console.warn('[instantly] steps analytics error:', err);
          return [];
        }),
        instantlyFetch<{ items: CustomTag[] }>('/tags?limit=all').catch(() => ({ items: [] })),
      ]);
      setCampaign(c);

      const analyticsArr = Array.isArray(a) ? a : Array.isArray((a as { data?: unknown }).data) ? (a as { data: CampaignAnalytics[] }).data : [];
      const matched = analyticsArr.find(
        (item) => item.campaign_id === campaignId || (item as Record<string, unknown>).id === campaignId,
      );
      setAnalytics(matched ?? null);

      const stepsArr = Array.isArray(s) ? s : Array.isArray((s as { data?: unknown }).data) ? (s as { data: CampaignStepAnalytics[] }).data : [];
      const filteredSteps = stepsArr
        .filter((item) => {
          const stepVal = String(item.step ?? '');
          if (stepVal === '\\N' || stepVal === 'null' || stepVal === '') return false;
          if ('campaign_id' in item && (item as Record<string, unknown>).campaign_id !== campaignId) return false;
          return true;
        })
        .map((item) => ({
          ...item,
          step: Number(item.step) || 0,
          variant: Number(item.variant) || 0,
        }))
        .sort((a, b) => (a.step as number) - (b.step as number) || (a.variant as number) - (b.variant as number));
      setSteps(filteredSteps);
      setAllTags(tags.items ?? []);

      setEditName(c.name);
      setEditDailyLimit(String(c.daily_limit ?? ''));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => { load(); }, [load]);

  const handleAction = useCallback(async (action: 'activate' | 'pause') => {
    setActionLoading(true);
    try {
      const updated = await instantlyFetch<Campaign>(`/campaigns/${campaignId}/${action}`, { method: 'POST' });
      setCampaign(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setActionLoading(false);
    }
  }, [campaignId]);

  const loadLeads = useCallback(async (append = false) => {
    setLeadsLoading(true);
    try {
      const data = await instantlyFetch<PaginatedResponse<Lead>>('/leads', {
        method: 'POST',
        body: JSON.stringify({
          action: 'list',
          campaign_id: campaignId,
          search: leadsSearch || undefined,
          limit: 50,
          starting_after: append ? leadsAfter : undefined,
        }),
      });
      const items = data.items ?? [];
      setLeads(append ? (prev) => [...prev, ...items] : items);
      setLeadsAfter(data.next_starting_after);
      setLeadsHasMore(!!data.next_starting_after);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки лидов');
    } finally {
      setLeadsLoading(false);
    }
  }, [campaignId, leadsSearch, leadsAfter]);

  useEffect(() => {
    if (tab === 'leads' && leads.length === 0 && !leadsLoading) loadLeads();
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const [exporting, setExporting] = useState<string | false>(false);
  const [clearing, setClearing] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const handleExport = useCallback(async (format: 'csv' | 'xlsx') => {
    setExporting(format);
    try {
      const data = await instantlyFetch<{ items: { email: string; first_name: string; last_name: string; company_name: string; title: string; phone: string; website: string; interest_status: number; timestamp_created: string }[]; total: number }>(
        `/leads/export?campaign_id=${campaignId}`,
      );
      const rows = data.items.map((l) => ({
        Email: l.email,
        'Имя': l.first_name,
        'Фамилия': l.last_name,
        'Компания': l.company_name,
        'Должность': l.title,
        'Телефон': l.phone,
        'Сайт': l.website,
        'Статус': (INTEREST_LABELS[l.interest_status ?? 0] ?? INTEREST_LABELS[0]).label,
        'Добавлен': l.timestamp_created ? new Date(l.timestamp_created).toLocaleDateString('ru-RU') : '',
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Leads');
      const safeName = (campaign?.name ?? 'leads').replace(/[^\w\sа-яёА-ЯЁ-]/gi, '').slice(0, 50);
      XLSX.writeFile(wb, `${safeName}.${format}`, { bookType: format });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка экспорта');
    } finally {
      setExporting(false);
    }
  }, [campaignId, campaign?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClearLeads = useCallback(async () => {
    setClearing(true);
    try {
      await instantlyFetch('/leads', {
        method: 'POST',
        body: JSON.stringify({ action: 'delete-by-campaign', campaign_id: campaignId }),
      });
      setLeads([]);
      setLeadsAfter(undefined);
      setLeadsHasMore(false);
      setShowClearConfirm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка очистки');
    } finally {
      setClearing(false);
    }
  }, [campaignId]);

  const handleSave = useCallback(async () => {
    if (!campaign) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {};
      if (editName !== campaign.name) payload.name = editName;
      if (editDailyLimit && Number(editDailyLimit) !== campaign.daily_limit) payload.daily_limit = Number(editDailyLimit);
      if (Object.keys(payload).length === 0) { setSaving(false); return; }
      const updated = await instantlyFetch<Campaign>(`/campaigns/${campaignId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      setCampaign(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }, [campaign, editName, editDailyLimit, campaignId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (error && !campaign) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8">
        <Link href={'/instantly/campaigns' as Route} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 mb-4">
          <ChevronLeft className="h-3 w-3" /> Кампании
        </Link>
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
      </div>
    );
  }

  if (!campaign) return null;

  const sentCount = analytics?.emails_sent_count ?? 0;
  const openCount = analytics?.open_count ?? 0;
  const replyCount = analytics?.reply_count ?? 0;
  const contactedCount = analytics?.new_leads_contacted_count ?? 0;
  const bouncedCount = analytics?.bounced_count ?? 0;
  const openRate = sentCount > 0 ? ((openCount / sentCount) * 100).toFixed(1) : '0';
  const replyRate = contactedCount > 0 ? ((replyCount / contactedCount) * 100).toFixed(1) : '0';
  const getTagDisplayName = (tagId: string) => {
    const tag = allTags.find((item) => item.id === tagId);
    return tag?.name ?? tag?.label ?? tagId;
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <Link href={'/instantly/campaigns' as Route} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 mb-4 transition-colors">
        <ChevronLeft className="h-3 w-3" /> Кампании
      </Link>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-zinc-900">{campaign.name}</h1>
          <div className="mt-1.5 flex items-center gap-3">
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadgeClass(campaign.status)}`}>
              {CampaignStatusLabels[campaign.status] ?? `Status ${campaign.status}`}
            </span>
            {campaign.timestamp_created && (
              <span className="text-xs text-zinc-400">
                Создана {new Date(campaign.timestamp_created).toLocaleDateString('ru-RU')}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {(campaign.status === CampaignStatus.Draft || campaign.status === CampaignStatus.Paused) && (
            <button
              onClick={() => handleAction('activate')}
              disabled={actionLoading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 transition-colors disabled:opacity-50"
            >
              {actionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Активировать
            </button>
          )}
          {campaign.status === CampaignStatus.Active && (
            <button
              onClick={() => handleAction('pause')}
              disabled={actionLoading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-2 text-sm font-medium text-white hover:bg-amber-600 transition-colors disabled:opacity-50"
            >
              {actionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />}
              Пауза
            </button>
          )}
          <a
            href={`https://app.instantly.ai/app/campaign/${campaign.id}/analytics`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 transition-colors"
          >
            <ExternalLink className="h-4 w-4" />
            Instantly
          </a>
        </div>
      </div>

      <div className="mb-6 flex items-center gap-1 rounded-lg border border-zinc-200 bg-white p-0.5 w-fit">
        {(['overview', 'steps', 'leads', 'settings'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-4 py-1.5 text-xs font-medium transition-colors ${
              tab === t ? 'bg-zinc-900 text-white' : 'text-zinc-500 hover:text-zinc-900'
            }`}
          >
            {{ overview: 'Обзор', steps: 'Шаги', leads: 'Лиды', settings: 'Настройки' }[t]}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <MetricCard label="Отправлено" value={sentCount} />
            <MetricCard label="Открытия" value={openCount} sub={`${openRate}% от отправленных`} />
            <MetricCard label="Ответы" value={replyCount} sub={`${replyRate}% от контактов`} />
            <MetricCard label="Bounce" value={bouncedCount} />
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="rounded-xl border border-zinc-200 bg-white p-5">
              <h3 className="mb-3 text-sm font-semibold text-zinc-900 flex items-center gap-2">
                <Settings className="h-4 w-4 text-zinc-400" /> Параметры
              </h3>
              <div className="divide-y divide-zinc-100">
                <InfoRow label="Дневной лимит" value={campaign.daily_limit ?? '—'} />
                <InfoRow label="Макс. лидов/день" value={campaign.daily_max_leads ?? '—'} />
                <InfoRow label="Интервал между письмами" value={campaign.email_gap ? `${campaign.email_gap} мин` : '—'} />
                <InfoRow label="Стоп на ответ" value={campaign.stop_on_reply ? 'Да' : 'Нет'} />
                <InfoRow label="Трекинг открытий" value={campaign.open_tracking ? 'Да' : 'Нет'} />
                <InfoRow label="Трекинг ссылок" value={campaign.link_tracking ? 'Да' : 'Нет'} />
                <InfoRow label="Evergreen" value={campaign.is_evergreen ? 'Да' : 'Нет'} />
              </div>
            </div>

            <div className="rounded-xl border border-zinc-200 bg-white p-5">
              <h3 className="mb-3 text-sm font-semibold text-zinc-900 flex items-center gap-2">
                <Mail className="h-4 w-4 text-zinc-400" /> Аккаунты отправки
              </h3>
              {(campaign.email_list && campaign.email_list.length > 0) || (campaign.email_tag_list && campaign.email_tag_list.length > 0) ? (
                <div className="space-y-3">
                  {campaign.email_tag_list && campaign.email_tag_list.length > 0 && (
                    <div>
                      <p className="mb-2 text-xs text-zinc-400">Теги отправки</p>
                      <div className="flex flex-wrap gap-2">
                        {campaign.email_tag_list.map((tagId) => (
                          <span key={tagId} className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-700">
                            {getTagDisplayName(tagId)}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {campaign.email_list && campaign.email_list.length > 0 && (
                    <div className="space-y-1.5">
                      {campaign.email_list.map((email) => (
                        <div key={email} className="rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-700 truncate">
                          {email}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-zinc-400 py-4 text-center">Нет привязанных аккаунтов</p>
              )}
            </div>
          </div>

          {campaign.sequences && campaign.sequences.length > 0 && campaign.sequences[0].steps && (
            <div className="mt-6 rounded-xl border border-zinc-200 bg-white p-5">
              <h3 className="mb-4 text-sm font-semibold text-zinc-900">Последовательность писем</h3>
              <div className="space-y-3">
                {campaign.sequences[0].steps.map((step, i) => {
                  const display = getStepDisplay(step);
                  return (
                    <div key={i} className="rounded-lg border border-zinc-100 p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
                          Шаг {i + 1}
                        </span>
                        {display.waitDays != null && display.waitDays > 0 && (
                          <span className="flex items-center gap-1 text-xs text-zinc-400">
                            <Clock className="h-3 w-3" /> ждать {display.waitDays} дн.
                          </span>
                        )}
                      </div>
                      {display.subject && (
                        <p className="text-sm font-medium text-zinc-800 mb-1">Тема: {display.subject}</p>
                      )}
                      {display.body && (
                        <div className="text-xs text-zinc-500 line-clamp-3 whitespace-pre-wrap">{display.body}</div>
                      )}
                      {display.variantsCount > 0 && (
                        <p className="mt-1 text-xs text-zinc-400">{display.variantsCount} вариант(ов)</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'steps' && (
        <div className="rounded-xl border border-zinc-200 bg-white">
          {steps.length === 0 && campaign.sequences?.[0]?.steps?.length ? (
            <div className="p-5">
              <p className="mb-4 text-xs text-zinc-400">Аналитика по шагам пока недоступна. Последовательность писем:</p>
              <div className="space-y-3">
                {campaign.sequences[0].steps.map((step, i) => {
                  const display = getStepDisplay(step);
                  return (
                    <div key={i} className="rounded-lg border border-zinc-100 p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">Шаг {i + 1}</span>
                        {display.waitDays != null && display.waitDays > 0 && (
                          <span className="flex items-center gap-1 text-xs text-zinc-400">
                            <Clock className="h-3 w-3" /> ждать {display.waitDays} дн.
                          </span>
                        )}
                      </div>
                      {display.subject && <p className="text-sm font-medium text-zinc-800 mb-1">Тема: {display.subject}</p>}
                      {display.body && <div className="text-xs text-zinc-500 line-clamp-3 whitespace-pre-wrap">{display.body}</div>}
                      {display.variantsCount > 0 && (
                        <p className="mt-1 text-xs text-zinc-400">{display.variantsCount} вариант(ов)</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : steps.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm text-zinc-400">Нет данных по шагам</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-100 text-left">
                    <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Шаг</th>
                    <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Вариант</th>
                    <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase text-right">Отправлено</th>
                    <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase text-right">Открытия</th>
                    <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase text-right">Ответы</th>
                    <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase text-right">Клики</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-50">
                  {steps.map((s, i) => {
                    const sent = s.sent ?? 0;
                    const opened = s.unique_opened ?? s.opened ?? 0;
                    const replied = s.unique_replies ?? s.replies ?? 0;
                    const clicked = s.unique_clicks ?? s.clicks ?? 0;
                    const openPct = sent > 0 ? ((opened / sent) * 100).toFixed(1) : '0';
                    const replyPct = sent > 0 ? ((replied / sent) * 100).toFixed(1) : '0';
                    return (
                      <tr key={i} className="hover:bg-zinc-50">
                        <td className="px-4 py-3 font-medium">{(s.step ?? 0) + 1}</td>
                        <td className="px-4 py-3 text-zinc-500">{String.fromCharCode(65 + (s.variant ?? 0))}</td>
                        <td className="px-4 py-3 text-right">{sent}</td>
                        <td className="px-4 py-3 text-right">{opened} <span className="text-zinc-400">({openPct}%)</span></td>
                        <td className="px-4 py-3 text-right">{replied} <span className="text-zinc-400">({replyPct}%)</span></td>
                        <td className="px-4 py-3 text-right">{clicked}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'leads' && (
        <div className="rounded-xl border border-zinc-200 bg-white">
          <div className="flex items-center gap-3 border-b border-zinc-100 p-4 flex-wrap">
            <div className="relative flex-1 min-w-[180px] max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <input
                type="text"
                placeholder="Поиск по email..."
                value={leadsSearch}
                onChange={(e) => setLeadsSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { setLeadsAfter(undefined); loadLeads(); }
                }}
                className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400"
              />
            </div>
            <button
              onClick={() => { setLeadsAfter(undefined); loadLeads(); }}
              disabled={leadsLoading}
              className="rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 transition-colors"
            >
              {leadsLoading && leads.length === 0 ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Обновить'}
            </button>
            <div className="flex items-center gap-1.5 ml-auto">
              <button
                onClick={() => handleExport('csv')}
                disabled={!!exporting || leads.length === 0}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 transition-colors"
              >
                {exporting === 'csv' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                CSV
              </button>
              <button
                onClick={() => handleExport('xlsx')}
                disabled={!!exporting || leads.length === 0}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 transition-colors"
              >
                {exporting === 'xlsx' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                XLSX
              </button>
              <button
                onClick={() => setShowClearConfirm(true)}
                disabled={leads.length === 0}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Очистить
              </button>
            </div>
          </div>

          {showClearConfirm && (
            <div className="border-b border-red-100 bg-red-50 px-5 py-4">
              <p className="text-sm font-medium text-red-800 mb-1">Удалить все лиды из этой кампании?</p>
              <p className="text-xs text-red-600 mb-3">Это действие необратимо. Все контакты будут удалены из кампании &ldquo;{campaign?.name}&rdquo;.</p>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleClearLeads}
                  disabled={clearing}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
                >
                  {clearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  Да, удалить все лиды
                </button>
                <button
                  onClick={() => setShowClearConfirm(false)}
                  className="rounded-lg border border-zinc-200 px-4 py-2 text-xs font-medium text-zinc-600 hover:bg-white transition-colors"
                >
                  Отмена
                </button>
              </div>
            </div>
          )}

          {leadsLoading && leads.length === 0 ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
            </div>
          ) : leads.length === 0 ? (
            <div className="py-16 text-center">
              <Users className="mx-auto h-8 w-8 text-zinc-300" />
              <p className="mt-3 text-sm text-zinc-500">Нет лидов в этой кампании</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-100 bg-zinc-50/50 text-left">
                      <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Email</th>
                      <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Имя</th>
                      <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Компания</th>
                      <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Статус</th>
                      <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Добавлен</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-50">
                    {leads.map((l) => {
                      const interest = INTEREST_LABELS[l.interest_status ?? 0] ?? INTEREST_LABELS[0];
                      return (
                        <tr key={l.id} className="hover:bg-zinc-50">
                          <td className="px-4 py-3 font-medium text-zinc-800 truncate max-w-[220px]">{l.email}</td>
                          <td className="px-4 py-3 text-zinc-500">{[l.first_name, l.last_name].filter(Boolean).join(' ') || '—'}</td>
                          <td className="px-4 py-3 text-zinc-500 truncate max-w-[180px]">{l.company_name || '—'}</td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${interest.cls}`}>
                              {interest.label}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs text-zinc-400">
                            {l.timestamp_created ? new Date(l.timestamp_created).toLocaleDateString('ru-RU') : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="border-t border-zinc-100 px-5 py-3 flex items-center justify-between">
                <span className="text-xs text-zinc-400">{leads.length} лидов загружено</span>
                {leadsHasMore && (
                  <button
                    onClick={() => loadLeads(true)}
                    disabled={leadsLoading}
                    className="inline-flex items-center gap-1 text-xs font-medium text-zinc-600 hover:text-zinc-900 disabled:opacity-50 transition-colors"
                  >
                    {leadsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ChevronRight className="h-3 w-3" />}
                    Загрузить ещё
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'settings' && (
        <div className="rounded-xl border border-zinc-200 bg-white p-6 max-w-lg">
          <h3 className="mb-4 text-sm font-semibold text-zinc-900">Редактировать кампанию</h3>
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500">Название</label>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500">Дневной лимит</label>
              <input
                type="number"
                value={editDailyLimit}
                onChange={(e) => setEditDailyLimit(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400"
              />
            </div>
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 transition-colors disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Сохранить
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
