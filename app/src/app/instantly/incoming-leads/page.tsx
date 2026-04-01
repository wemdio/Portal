'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  ChevronLeft, ChevronRight, Loader2, Search, CheckCircle2,
  XCircle, AlertCircle, Eye, Mail,
} from 'lucide-react';
import { instantlyFetch } from '@/lib/instantly/fetcher';
import type { Campaign, PaginatedResponse } from '@/lib/instantly/types';
import { supabase } from '@/lib/supabaseClient';

type LeadQualification = {
  id: string;
  campaign_id: string;
  campaign_name: string | null;
  lead_email: string;
  lead_name: string | null;
  company_name: string | null;
  reply_subject: string | null;
  reply_preview: string | null;
  reply_body: string | null;
  last_outbound_preview: string | null;
  status: 'lead' | 'not_lead' | 'needs_review' | 'error' | 'pending' | 'processing';
  proposal_seen: boolean | null;
  interest_signals: string[] | null;
  ai_reason: string | null;
  ai_confidence: number | null;
  reply_timestamp: string | null;
  created_at: string;
};

type QualifiedLeadsResponse = {
  items: LeadQualification[];
  total: number;
  limit: number;
  offset: number;
};

const STATUS_CONFIG: Record<string, { label: string; icon: React.ElementType; cls: string }> = {
  lead: { label: 'Лид', icon: CheckCircle2, cls: 'text-emerald-700 bg-emerald-50' },
  not_lead: { label: 'Не лид', icon: XCircle, cls: 'text-zinc-500 bg-zinc-100' },
  needs_review: { label: 'На проверку', icon: AlertCircle, cls: 'text-amber-700 bg-amber-50' },
  error: { label: 'Ошибка', icon: XCircle, cls: 'text-red-600 bg-red-50' },
  pending: { label: 'В очереди', icon: Loader2, cls: 'text-blue-600 bg-blue-50' },
  processing: { label: 'Обработка', icon: Loader2, cls: 'text-blue-600 bg-blue-50' },
};

const STATUS_FILTERS = [
  { value: 'all', label: 'Все' },
  { value: 'lead', label: 'Лиды' },
  { value: 'needs_review', label: 'На проверку' },
  { value: 'not_lead', label: 'Не лид' },
];

async function fetchWithAuth<T>(path: string): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not authenticated');
  const res = await fetch(path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return (await res.json()) as T;
}

function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.error;
  const Icon = config.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${config.cls}`}>
      <Icon className="h-3 w-3" />
      {config.label}
    </span>
  );
}

function ConfidenceBar({ value }: { value: number | null }) {
  if (value === null || value === undefined) return null;
  const pct = Math.round(value * 100);
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-16 rounded-full bg-zinc-100 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            pct >= 80 ? 'bg-emerald-500' : pct >= 50 ? 'bg-amber-400' : 'bg-zinc-300'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-zinc-400">{pct}%</span>
    </div>
  );
}

function LeadRow({
  item,
  expanded,
  onToggle,
}: {
  item: LeadQualification;
  expanded: boolean;
  onToggle: () => void;
}) {
  const date = item.reply_timestamp ?? item.created_at;
  return (
    <div className={`border-b border-zinc-100 ${item.status === 'lead' ? 'bg-emerald-50/20' : ''}`}>
      <button onClick={onToggle} className="w-full text-left px-5 py-3.5 hover:bg-zinc-50/80 transition-colors">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-1">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-medium text-zinc-900 truncate">
                  {item.lead_name || item.lead_email}
                </span>
                {item.company_name && (
                  <span className="text-xs text-zinc-400 truncate hidden sm:inline">
                    {item.company_name}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <ConfidenceBar value={item.ai_confidence} />
                <StatusBadge status={item.status} />
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-zinc-500 mb-0.5">
              <span className="truncate">{item.lead_email}</span>
              <span className="text-zinc-300">·</span>
              <span className="truncate text-zinc-400">{item.campaign_name ?? item.campaign_id}</span>
            </div>
            {!expanded && (
              <p className="text-xs text-zinc-400 truncate mt-0.5">
                {item.reply_subject ? `${item.reply_subject}: ` : ''}
                {item.reply_preview ?? ''}
              </p>
            )}
          </div>
          <span className="shrink-0 text-[11px] text-zinc-400 mt-0.5">
            {date ? new Date(date).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="px-5 pb-4 pt-1 space-y-3">
          {item.ai_reason && (
            <div className="rounded-lg border border-zinc-100 bg-zinc-50/50 p-3">
              <p className="text-xs font-medium text-zinc-500 mb-1">AI-анализ</p>
              <p className="text-sm text-zinc-700">{item.ai_reason}</p>
              {item.interest_signals && item.interest_signals.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {item.interest_signals.map((s, i) => (
                    <span key={i} className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">
                      {s}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-2 flex items-center gap-3 text-[11px] text-zinc-400">
                <span>Предложение видели: {item.proposal_seen ? 'Да' : 'Нет'}</span>
                {item.ai_confidence !== null && (
                  <span>Уверенность: {Math.round(item.ai_confidence * 100)}%</span>
                )}
              </div>
            </div>
          )}

          {item.last_outbound_preview && (
            <div>
              <p className="text-xs font-medium text-zinc-500 mb-1">Наше последнее письмо</p>
              <div className="rounded-lg border border-zinc-100 bg-zinc-50/50 p-3 text-sm text-zinc-600 whitespace-pre-wrap max-h-32 overflow-y-auto">
                {item.last_outbound_preview}
              </div>
            </div>
          )}

          <div>
            <p className="text-xs font-medium text-zinc-500 mb-1">
              Ответ: {item.reply_subject ?? '(без темы)'}
            </p>
            <div className="rounded-lg border border-zinc-100 bg-white p-3 text-sm text-zinc-700 whitespace-pre-wrap max-h-48 overflow-y-auto">
              {item.reply_body ?? item.reply_preview ?? '(пусто)'}
            </div>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <Link
              href={`/instantly/emails?campaign_id=${item.campaign_id}` as Route}
              className="inline-flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-800 transition-colors"
            >
              <Mail className="h-3 w-3" />
              Перейти к письмам
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

export default function IncomingLeadsPage() {
  const [items, setItems] = useState<LeadQualification[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState('lead');
  const [campaignId, setCampaignId] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const LIMIT = 30;

  const [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(true);

  useEffect(() => {
    instantlyFetch<PaginatedResponse<Campaign>>('/campaigns?limit=all')
      .then((res) => setCampaigns((res.items ?? []).map((c) => ({ id: c.id, name: c.name }))))
      .catch(() => setCampaigns([]))
      .finally(() => setCampaignsLoading(false));
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        status: statusFilter,
        limit: String(LIMIT),
        offset: String(offset),
      });
      if (campaignId) params.set('campaign_id', campaignId);
      if (search) params.set('search', search);
      if (!campaignId) params.set('use_preferences', 'true');

      const data = await fetchWithAuth<QualifiedLeadsResponse>(
        `/api/instantly/qualified-leads?${params.toString()}`,
      );
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, campaignId, search, offset]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSearch = () => {
    setOffset(0);
    loadData();
  };

  const hasMore = offset + LIMIT < total;
  const leadCount = items.filter((i) => i.status === 'lead').length;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <Link
        href={'/instantly' as Route}
        className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 mb-3 transition-colors"
      >
        <ChevronLeft className="h-3 w-3" /> Instantly
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900">Входящие лиды</h1>
        <p className="mt-1 text-sm text-zinc-500">
          AI-квалификация ответов по кампаниям Instantly
        </p>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-zinc-200 bg-white overflow-hidden">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => { setStatusFilter(f.value); setOffset(0); }}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                statusFilter === f.value
                  ? 'bg-zinc-900 text-white'
                  : 'text-zinc-500 hover:bg-zinc-50'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <select
          value={campaignId}
          onChange={(e) => { setCampaignId(e.target.value); setOffset(0); }}
          className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm focus:border-zinc-400 focus:outline-none max-w-[260px]"
          disabled={campaignsLoading}
        >
          <option value="">Мои кампании</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        <div className="relative flex-1 min-w-[160px] max-w-xs">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            placeholder="Поиск..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="w-full rounded-lg border border-zinc-200 bg-white py-1.5 pl-9 pr-3 text-sm focus:border-zinc-400 focus:outline-none"
          />
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white py-16 text-center">
          <Eye className="mx-auto h-8 w-8 text-zinc-300" />
          <p className="mt-3 text-sm text-zinc-500">
            {statusFilter === 'lead'
              ? 'Квалифицированных лидов пока нет'
              : 'Ничего не найдено'}
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            Лиды появятся автоматически — воркер периодически проверяет новые ответы в выбранных кампаниях
          </p>
        </div>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between text-xs text-zinc-400">
            <span>
              {total} {total === 1 ? 'результат' : 'результатов'}
              {statusFilter === 'all' && leadCount > 0 && ` · ${leadCount} лидов`}
            </span>
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
            {items.map((item) => (
              <LeadRow
                key={item.id}
                item={item}
                expanded={expandedId === item.id}
                onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
              />
            ))}
          </div>

          <div className="mt-4 flex items-center justify-between">
            <button
              onClick={() => setOffset(Math.max(0, offset - LIMIT))}
              disabled={offset === 0}
              className="inline-flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-800 disabled:opacity-30 transition-colors"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Назад
            </button>
            <span className="text-xs text-zinc-400">
              {offset + 1}–{Math.min(offset + LIMIT, total)} из {total}
            </span>
            <button
              onClick={() => hasMore && setOffset(offset + LIMIT)}
              disabled={!hasMore}
              className="inline-flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-800 disabled:opacity-30 transition-colors"
            >
              Далее <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
