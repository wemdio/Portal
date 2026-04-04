'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  ChevronLeft, ChevronRight, Loader2, Search, CheckCircle2,
  XCircle, AlertCircle, Eye, Mail, Sparkles, CircleDot, MessageSquare, Copy,
  Send, X, Check,
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
  status: 'lead' | 'not_lead' | 'needs_review' | 'objection' | 'error' | 'pending' | 'processing';
  proposal_seen: boolean | null;
  interest_signals: string[] | null;
  ai_reason: string | null;
  ai_confidence: number | null;
  reply_timestamp: string | null;
  created_at: string;
  read_at: string | null;
  read_by: string | null;
  objection_handleable: boolean | null;
  objection_draft: string | null;
};

type QualifiedLeadsResponse = {
  items: LeadQualification[];
  total: number;
  limit: number;
  offset: number;
};

const STATUS_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string; bg: string; ring: string }> = {
  lead:         { label: 'Лид',         icon: CheckCircle2,   color: 'text-emerald-600', bg: 'bg-emerald-50',  ring: 'ring-emerald-200' },
  objection:    { label: 'Возражение',  icon: MessageSquare,  color: 'text-violet-600',  bg: 'bg-violet-50',   ring: 'ring-violet-200' },
  not_lead:     { label: 'Не лид',      icon: XCircle,        color: 'text-zinc-400',    bg: 'bg-zinc-50',     ring: 'ring-zinc-200' },
  needs_review: { label: 'На проверку', icon: AlertCircle,    color: 'text-amber-600',   bg: 'bg-amber-50',    ring: 'ring-amber-200' },
  error:        { label: 'Ошибка',      icon: XCircle,        color: 'text-red-500',     bg: 'bg-red-50',      ring: 'ring-red-200' },
  pending:      { label: 'В очереди',   icon: Loader2,        color: 'text-blue-500',    bg: 'bg-blue-50',     ring: 'ring-blue-200' },
  processing:   { label: 'Обработка',   icon: Loader2,        color: 'text-blue-500',    bg: 'bg-blue-50',     ring: 'ring-blue-200' },
};

const STATUS_FILTERS = [
  { value: 'all', label: 'Все' },
  { value: 'lead', label: 'Лиды' },
  { value: 'objection', label: 'Возражения' },
  { value: 'needs_review', label: 'На проверку' },
  { value: 'not_lead', label: 'Не лид' },
];

async function fetchWithAuth<T>(path: string, options?: RequestInit): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not authenticated');
  const res = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...options?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.error;
  const Icon = config.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${config.color} ${config.bg} ${config.ring}`}>
      <Icon className="h-3 w-3" />
      {config.label}
    </span>
  );
}

function ConfidenceBar({ value }: { value: number | null }) {
  if (value === null || value === undefined) return null;
  const pct = Math.round(value * 100);
  const color = pct >= 80 ? 'bg-emerald-500' : pct >= 50 ? 'bg-amber-400' : 'bg-zinc-300';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 rounded-full bg-zinc-100 overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] tabular-nums text-zinc-400 font-medium">{pct}%</span>
    </div>
  );
}

function UnreadDot() {
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0" title="Новое">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-40" />
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500" />
    </span>
  );
}

function ObjectionDraftBlock({ draft }: { draft: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard may not be available */ }
  };

  return (
    <div className="rounded-xl border border-violet-200/80 bg-gradient-to-br from-violet-50 to-white p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <MessageSquare className="h-3.5 w-3.5 text-violet-500" />
          <span className="text-xs font-semibold text-violet-700 tracking-wide uppercase">
            Черновик ответа на возражение
          </span>
        </div>
        <button
          onClick={handleCopy}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-violet-500 hover:bg-violet-100 transition-colors"
        >
          {copied ? <CheckCircle2 className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Скопировано' : 'Копировать'}
        </button>
      </div>
      <p className="text-sm text-zinc-700 leading-relaxed whitespace-pre-wrap">{draft}</p>
    </div>
  );
}

type ForwardClient = {
  id: string;
  full_name: string | null;
  email: string | null;
  telegram_chats: { chat_id: number; chat_title: string | null }[];
};

function ForwardToClientDialog({
  qualificationId,
  campaignId,
  onClose,
  onForwarded,
}: {
  qualificationId: string;
  campaignId: string;
  onClose: () => void;
  onForwarded: () => void;
}) {
  const [clients, setClients] = useState<ForwardClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [selectedClient, setSelectedClient] = useState<string>('');
  const [selectedChat, setSelectedChat] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    fetchWithAuth<{ clients: ForwardClient[] }>(
      `/api/instantly/forward-clients?campaign_id=${campaignId}`,
    )
      .then((res) => setClients(res.clients))
      .catch((err) => setError(err instanceof Error ? err.message : 'Ошибка'))
      .finally(() => setLoading(false));
  }, [campaignId]);

  const currentClient = clients.find((c) => c.id === selectedClient);

  const handleForward = async () => {
    if (!selectedClient) return;
    setSending(true);
    setError('');
    try {
      await fetchWithAuth('/api/instantly/qualified-leads/forward', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          qualification_id: qualificationId,
          client_user_id: selectedClient,
          telegram_chat_id: selectedChat,
        }),
      });
      setSuccess(true);
      setTimeout(() => { onForwarded(); onClose(); }, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка отправки');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-3 rounded-xl border border-blue-200/80 bg-gradient-to-br from-blue-50 to-white p-4 animate-in fade-in slide-in-from-top-1 duration-200">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5">
          <Send className="h-3.5 w-3.5 text-blue-500" />
          <span className="text-xs font-semibold text-blue-700 tracking-wide uppercase">
            Передать клиенту
          </span>
        </div>
        <button onClick={onClose} className="rounded-lg p-1 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
        </div>
      ) : success ? (
        <div className="flex items-center gap-2 py-3 text-sm text-emerald-600 font-medium">
          <CheckCircle2 className="h-4 w-4" />
          Лид успешно передан клиенту
        </div>
      ) : (
        <div className="space-y-3">
          {error && <p className="text-xs text-red-500 font-medium">{error}</p>}

          {clients.length === 0 ? (
            <p className="text-xs text-zinc-400 py-2">
              Нет клиентов с доступом к этой кампании. Назначьте доступ в админ-панели.
            </p>
          ) : (
            <>
              <div>
                <label className="text-[11px] font-medium text-zinc-500 mb-1 block">Клиент</label>
                <select
                  value={selectedClient}
                  onChange={(e) => {
                    setSelectedClient(e.target.value);
                    setSelectedChat(null);
                  }}
                  className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
                >
                  <option value="">Выберите клиента...</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.full_name || c.email || c.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </div>

              {currentClient && currentClient.telegram_chats.length > 0 && (
                <div>
                  <label className="text-[11px] font-medium text-zinc-500 mb-1 block">
                    Telegram-чат (необязательно)
                  </label>
                  <select
                    value={selectedChat ?? ''}
                    onChange={(e) => setSelectedChat(e.target.value ? Number(e.target.value) : null)}
                    className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
                  >
                    <option value="">Не отправлять в Telegram</option>
                    {currentClient.telegram_chats.map((ch) => (
                      <option key={ch.chat_id} value={ch.chat_id}>
                        {ch.chat_title || `Chat ${ch.chat_id}`}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  onClick={onClose}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-500 hover:bg-zinc-100 transition-colors"
                >
                  Отмена
                </button>
                <button
                  onClick={handleForward}
                  disabled={!selectedClient || sending}
                  className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
                >
                  {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                  Передать
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function LeadRow({
  item,
  expanded,
  onToggle,
  isRead,
}: {
  item: LeadQualification;
  expanded: boolean;
  onToggle: () => void;
  isRead: boolean;
}) {
  const [showForward, setShowForward] = useState(false);
  const date = item.reply_timestamp ?? item.created_at;
  const isLead = item.status === 'lead';
  const isObjection = item.status === 'objection';
  const canForward = isLead || isObjection || item.status === 'needs_review';

  return (
    <div
      className={`
        group transition-colors duration-200 border-b border-zinc-100 last:border-b-0
        ${isLead && !isRead ? 'bg-emerald-50/40' : ''}
        ${!isRead ? 'bg-white' : 'bg-zinc-50/50'}
      `}
    >
      <button onClick={onToggle} className="w-full text-left px-5 py-4 hover:bg-zinc-50/80 transition-colors duration-150">
        <div className="flex items-start gap-3">
          <div className="mt-1.5 shrink-0 w-3 flex justify-center">
            {!isRead && <UnreadDot />}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-3 mb-1">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`text-sm truncate ${!isRead ? 'font-semibold text-zinc-900' : 'font-normal text-zinc-500'}`}>
                  {item.lead_name || item.lead_email}
                </span>
                {item.company_name && (
                  <span className="text-xs text-zinc-400 truncate hidden sm:inline">
                    {item.company_name}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <ConfidenceBar value={item.ai_confidence} />
                <StatusBadge status={item.status} />
                <span className="text-[11px] text-zinc-400 tabular-nums whitespace-nowrap">
                  {date ? new Date(date).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
                </span>
              </div>
            </div>

            <div className={`flex items-center gap-1.5 text-xs mb-1 ${!isRead ? 'text-zinc-600' : 'text-zinc-400'}`}>
              <Mail className="h-3 w-3 shrink-0 text-zinc-300" />
              <span className="truncate">{item.lead_email}</span>
              <span className="text-zinc-200 mx-0.5">·</span>
              <span className="truncate text-zinc-400">{item.campaign_name ?? item.campaign_id.slice(0, 8)}</span>
            </div>

            {!expanded && (item.reply_subject || item.reply_preview) && (
              <p className={`text-xs truncate mt-0.5 ${!isRead ? 'text-zinc-500' : 'text-zinc-400'}`}>
                {item.reply_subject && <span className="font-medium">{item.reply_subject}: </span>}
                {item.reply_preview ?? ''}
              </p>
            )}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-5 pb-5 pt-1 ml-8 space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
          {item.ai_reason && (
            <div className="rounded-xl border border-zinc-200/80 bg-gradient-to-br from-zinc-50 to-white p-4">
              <div className="flex items-center gap-1.5 mb-2">
                <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                <span className="text-xs font-semibold text-zinc-700 tracking-wide uppercase">AI-анализ</span>
              </div>
              <p className="text-sm text-zinc-700 leading-relaxed">{item.ai_reason}</p>
              {item.interest_signals && item.interest_signals.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {item.interest_signals.map((s, i) => (
                    <span key={i} className="rounded-md bg-emerald-50 ring-1 ring-emerald-200 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                      {s}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-3 flex items-center gap-4 text-[11px] text-zinc-400">
                <span className="flex items-center gap-1">
                  <CircleDot className="h-3 w-3" />
                  Предложение: {item.proposal_seen ? 'видели' : 'не видели'}
                </span>
                {item.ai_confidence !== null && (
                  <span>Уверенность: {Math.round(item.ai_confidence * 100)}%</span>
                )}
              </div>
            </div>
          )}

          {item.objection_handleable && item.objection_draft && (
            <ObjectionDraftBlock draft={item.objection_draft} />
          )}

          {item.error_message && (
            <div className="rounded-xl border border-red-200 bg-red-50/50 p-4">
              <p className="text-xs font-semibold text-red-600 mb-1">Ошибка квалификации</p>
              <p className="text-sm text-red-700">{(item as LeadQualification & { error_message?: string }).error_message}</p>
            </div>
          )}

          {item.last_outbound_preview && (
            <div>
              <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wide mb-1.5">Наше последнее письмо</p>
              <div className="rounded-xl border border-zinc-200/80 bg-zinc-50/50 p-4 text-sm text-zinc-600 whitespace-pre-wrap max-h-32 overflow-y-auto leading-relaxed">
                {item.last_outbound_preview}
              </div>
            </div>
          )}

          <div>
            <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wide mb-1.5">
              Ответ{item.reply_subject ? `: ${item.reply_subject}` : ''}
            </p>
            <div className="rounded-xl border border-zinc-200/80 bg-white p-4 text-sm text-zinc-700 whitespace-pre-wrap max-h-48 overflow-y-auto leading-relaxed shadow-sm">
              {item.reply_body ?? item.reply_preview ?? '(пусто)'}
            </div>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <Link
              href={`/instantly/emails?campaign_id=${item.campaign_id}` as Route}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-700 transition-colors"
            >
              <Mail className="h-3.5 w-3.5" />
              Перейти к письмам
            </Link>
            {canForward && (
              <button
                onClick={(e) => { e.stopPropagation(); setShowForward(!showForward); }}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-500 hover:text-blue-700 transition-colors"
              >
                <Send className="h-3.5 w-3.5" />
                Передать клиенту
              </button>
            )}
          </div>

          {showForward && (
            <ForwardToClientDialog
              qualificationId={item.id}
              campaignId={item.campaign_id}
              onClose={() => setShowForward(false)}
              onForwarded={() => setShowForward(false)}
            />
          )}
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
  const readIdsRef = useRef<Set<string>>(new Set());

  const [statusFilter, setStatusFilter] = useState('all');
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

  const markAsRead = useCallback(async (id: string) => {
    if (readIdsRef.current.has(id)) return;
    readIdsRef.current.add(id);

    setItems(prev => prev.map(item =>
      item.id === id ? { ...item, read_at: new Date().toISOString() } : item
    ));

    try {
      await fetchWithAuth('/api/instantly/qualified-leads', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      });
    } catch {
      readIdsRef.current.delete(id);
    }
  }, []);

  const handleToggle = useCallback((id: string) => {
    const isOpening = expandedId !== id;
    setExpandedId(isOpening ? id : null);
    if (isOpening) {
      const item = items.find(i => i.id === id);
      if (item && !item.read_at) {
        markAsRead(id);
      }
    }
  }, [expandedId, items, markAsRead]);

  const handleSearch = () => {
    setOffset(0);
    loadData();
  };

  const hasMore = offset + LIMIT < total;
  const unreadCount = items.filter(i => !i.read_at).length;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <Link
        href={'/instantly' as Route}
        className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 mb-4 transition-colors"
      >
        <ChevronLeft className="h-3 w-3" /> Instantly
      </Link>

      <div className="mb-8">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-zinc-900 tracking-tight">Входящие лиды</h1>
          {unreadCount > 0 && (
            <span className="inline-flex items-center justify-center h-5 min-w-5 px-1.5 rounded-full bg-blue-500 text-[10px] font-bold text-white tabular-nums">
              {unreadCount}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          AI-квалификация ответов по кампаниям Instantly
        </p>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="flex rounded-xl border border-zinc-200 bg-white overflow-hidden shadow-sm">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => { setStatusFilter(f.value); setOffset(0); }}
              className={`px-4 py-2 text-xs font-semibold transition-all duration-150 ${
                statusFilter === f.value
                  ? 'bg-zinc-900 text-white shadow-inner'
                  : 'text-zinc-500 hover:bg-zinc-50 hover:text-zinc-700'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <select
          value={campaignId}
          onChange={(e) => { setCampaignId(e.target.value); setOffset(0); }}
          className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-100 max-w-[260px] transition-all"
          disabled={campaignsLoading}
        >
          <option value="">Мои кампании</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        <div className="relative flex-1 min-w-[160px] max-w-xs">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-300" />
          <input
            type="text"
            placeholder="Поиск по email, имени, компании..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="w-full rounded-xl border border-zinc-200 bg-white py-2 pl-10 pr-3 text-sm shadow-sm focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-100 transition-all placeholder:text-zinc-300"
          />
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600 font-medium">
          {error}
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-300" />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-zinc-200 bg-white py-20 text-center shadow-sm">
          <div className="mx-auto h-12 w-12 rounded-full bg-zinc-100 flex items-center justify-center mb-4">
            <Eye className="h-6 w-6 text-zinc-300" />
          </div>
          <p className="text-sm font-medium text-zinc-600">
            {statusFilter === 'lead'
              ? 'Квалифицированных лидов пока нет'
              : 'Ничего не найдено'}
          </p>
          <p className="mt-1.5 text-xs text-zinc-400 max-w-sm mx-auto">
            Лиды появятся автоматически — воркер проверяет новые ответы в выбранных кампаниях каждые 30 секунд
          </p>
        </div>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between text-xs text-zinc-400">
            <span className="font-medium">
              {total} {total === 1 ? 'результат' : total < 5 ? 'результата' : 'результатов'}
              {unreadCount > 0 && <span className="text-blue-500 ml-1.5">· {unreadCount} новых</span>}
            </span>
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          </div>

          <div className="rounded-2xl border border-zinc-200 bg-white overflow-hidden shadow-sm">
            {items.map((item) => (
              <LeadRow
                key={item.id}
                item={item}
                expanded={expandedId === item.id}
                onToggle={() => handleToggle(item.id)}
                isRead={!!item.read_at}
              />
            ))}
          </div>

          <div className="mt-5 flex items-center justify-between">
            <button
              onClick={() => setOffset(Math.max(0, offset - LIMIT))}
              disabled={offset === 0}
              className="inline-flex items-center gap-1 text-xs font-medium text-zinc-400 hover:text-zinc-700 disabled:opacity-30 transition-colors"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Назад
            </button>
            <span className="text-xs text-zinc-400 tabular-nums">
              {offset + 1}–{Math.min(offset + LIMIT, total)} из {total}
            </span>
            <button
              onClick={() => hasMore && setOffset(offset + LIMIT)}
              disabled={!hasMore}
              className="inline-flex items-center gap-1 text-xs font-medium text-zinc-400 hover:text-zinc-700 disabled:opacity-30 transition-colors"
            >
              Далее <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
