'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  ChevronLeft, ChevronRight, Loader2, Search, CheckCircle2,
  XCircle, AlertCircle, Eye, Mail, Sparkles, CircleDot, MessageSquare, Copy,
  Send, X, Check, ArrowUpRight, User, Building2, Tag,
} from 'lucide-react';
import { instantlyFetch } from '@/lib/instantly/fetcher';
import type { Campaign, PaginatedResponse } from '@/lib/instantly/types';
import { supabase } from '@/lib/supabaseClient';

/* ─── Types ──────────────────────────────────────────────────────────────────── */

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
  error_message: string | null;
};

type QualifiedLeadsResponse = {
  items: LeadQualification[];
  total: number;
  limit: number;
  offset: number;
  counts?: Record<string, number>;
};

/* ─── Constants ──────────────────────────────────────────────────────────────── */

const STATUS_META: Record<string, {
  label: string; icon: React.ElementType;
  color: string; bg: string; ring: string; border: string;
}> = {
  lead:         { label: 'Лид',         icon: CheckCircle2,  color: 'text-emerald-600', bg: 'bg-emerald-50',  ring: 'ring-emerald-200', border: 'border-l-emerald-500' },
  objection:    { label: 'Возражение',  icon: MessageSquare, color: 'text-violet-600',  bg: 'bg-violet-50',   ring: 'ring-violet-200',  border: 'border-l-violet-500' },
  needs_review: { label: 'На проверку', icon: AlertCircle,   color: 'text-amber-600',   bg: 'bg-amber-50',    ring: 'ring-amber-200',   border: 'border-l-amber-400' },
  not_lead:     { label: 'Не лид',      icon: XCircle,       color: 'text-zinc-400',    bg: 'bg-zinc-50',     ring: 'ring-zinc-200',    border: 'border-l-zinc-300' },
  error:        { label: 'Ошибка',      icon: XCircle,       color: 'text-red-500',     bg: 'bg-red-50',      ring: 'ring-red-200',     border: 'border-l-red-400' },
  pending:      { label: 'В очереди',   icon: Loader2,       color: 'text-blue-500',    bg: 'bg-blue-50',     ring: 'ring-blue-200',    border: 'border-l-blue-300' },
  processing:   { label: 'Обработка',   icon: Loader2,       color: 'text-blue-500',    bg: 'bg-blue-50',     ring: 'ring-blue-200',    border: 'border-l-blue-300' },
};

const STATUS_FILTERS = [
  { value: 'all', label: 'Все' },
  { value: 'lead', label: 'Лиды' },
  { value: 'objection', label: 'Возражения' },
  { value: 'needs_review', label: 'На проверку' },
  { value: 'not_lead', label: 'Не лид' },
];

/* ─── Helpers ────────────────────────────────────────────────────────────────── */

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

function formatDate(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

/* ─── Small Components ───────────────────────────────────────────────────────── */

function StatusBadge({ status, size = 'sm' }: { status: string; size?: 'sm' | 'lg' }) {
  const m = STATUS_META[status] ?? STATUS_META.error;
  const Icon = m.icon;
  const cls = size === 'lg'
    ? `gap-1.5 px-3 py-1.5 text-xs ${m.color} ${m.bg} ring-1 ${m.ring}`
    : `gap-1 px-2 py-0.5 text-[10px] ${m.color} ${m.bg} ring-1 ${m.ring}`;
  return (
    <span className={`inline-flex items-center rounded-full font-semibold ${cls}`}>
      <Icon className={size === 'lg' ? 'h-3.5 w-3.5' : 'h-3 w-3'} />
      {m.label}
    </span>
  );
}

function ConfidenceBar({ value }: { value: number | null }) {
  if (value === null || value === undefined) return null;
  const pct = Math.round(value * 100);
  const color = pct >= 80 ? 'bg-emerald-500' : pct >= 50 ? 'bg-amber-400' : 'bg-zinc-300';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 rounded-full bg-zinc-100 overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] tabular-nums text-zinc-400 font-medium">{pct}%</span>
    </div>
  );
}

/* ─── Forward Dialog ─────────────────────────────────────────────────────────── */

type BotChat = { chat_id: number; chat_title: string | null; chat_type: string | null };

function ForwardToClientDialog({
  qualificationId, onClose, onForwarded,
}: {
  qualificationId: string; onClose: () => void; onForwarded: () => void;
}) {
  const [allChats, setAllChats] = useState<BotChat[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedChat, setSelectedChat] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const loadChats = useCallback(async (scan = false) => {
    try {
      const url = scan ? '/api/instantly/bot-chats?scan=true' : '/api/instantly/bot-chats';
      const res = await fetchWithAuth<{ chats: BotChat[] }>(url);
      setAllChats(res.chats ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки чатов');
    }
  }, []);

  useEffect(() => {
    loadChats().finally(() => setLoading(false));
  }, [loadChats]);

  const handleScan = async () => {
    setScanning(true);
    setError('');
    await loadChats(true);
    setScanning(false);
  };

  const filtered = allChats.filter((c) =>
    !search || (c.chat_title ?? '').toLowerCase().includes(search.toLowerCase()),
  );

  const handleForward = async () => {
    if (!selectedChat) return;
    setSending(true);
    setError('');
    try {
      await fetchWithAuth('/api/instantly/qualified-leads/forward', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qualification_id: qualificationId, telegram_chat_id: selectedChat }),
      });
      setSuccess(true);
      setTimeout(() => { onForwarded(); onClose(); }, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка отправки');
    } finally {
      setSending(false);
    }
  };

  const selectedTitle = allChats.find((c) => c.chat_id === selectedChat)?.chat_title;

  return (
    <div className="rounded-xl border border-blue-200/80 bg-gradient-to-br from-blue-50 to-white p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5">
          <Send className="h-3.5 w-3.5 text-blue-500" />
          <span className="text-xs font-semibold text-blue-700 uppercase tracking-wide">Передать в Telegram</span>
        </div>
        <button onClick={onClose} className="rounded-lg p-1 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-blue-400" /></div>
      ) : success ? (
        <div className="flex items-center gap-2 py-3 text-sm text-emerald-600 font-medium"><CheckCircle2 className="h-4 w-4" />Лид передан в Telegram</div>
      ) : (
        <div className="space-y-3">
          {error && <p className="text-xs text-red-500 font-medium">{error}</p>}

          {/* Search + refresh */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-300 pointer-events-none" />
              <input
                type="text"
                placeholder="Поиск чата..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-8 pr-3 text-sm focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100 placeholder:text-zinc-300"
              />
            </div>
            <button
              onClick={handleScan}
              disabled={scanning}
              title="Обновить список чатов из Telegram"
              className="shrink-0 rounded-lg border border-zinc-200 p-2 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 transition-colors"
            >
              {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" /><path d="M16 21h5v-5" />
                </svg>
              )}
            </button>
          </div>

          {/* Chat list */}
          <div className="max-h-52 overflow-y-auto rounded-lg border border-zinc-200 bg-white divide-y divide-zinc-100">
            {filtered.length === 0 ? (
              <div className="py-6 text-center">
                <p className="text-xs text-zinc-400">
                  {allChats.length === 0 ? 'Чаты не найдены' : 'Ничего не найдено'}
                </p>
                {allChats.length === 0 && (
                  <button onClick={handleScan} disabled={scanning}
                    className="mt-2 text-xs text-blue-500 hover:text-blue-700 font-medium transition-colors">
                    {scanning ? 'Сканирование...' : 'Загрузить чаты из Telegram'}
                  </button>
                )}
              </div>
            ) : (
              filtered.map((chat) => (
                <button
                  key={chat.chat_id}
                  onClick={() => setSelectedChat(chat.chat_id)}
                  className={`w-full text-left px-3 py-2.5 text-sm transition-colors flex items-center gap-2 ${
                    selectedChat === chat.chat_id
                      ? 'bg-blue-50 text-blue-700 font-medium'
                      : 'hover:bg-zinc-50 text-zinc-700'
                  }`}
                >
                  <MessageSquare className={`h-3.5 w-3.5 shrink-0 ${selectedChat === chat.chat_id ? 'text-blue-500' : 'text-zinc-300'}`} />
                  <span className="truncate">{chat.chat_title || `Chat ${chat.chat_id}`}</span>
                  {selectedChat === chat.chat_id && <Check className="h-3.5 w-3.5 ml-auto shrink-0 text-blue-500" />}
                </button>
              ))
            )}
          </div>

          {/* Action buttons */}
          <div className="flex items-center justify-between pt-1">
            {selectedChat ? (
              <p className="text-xs text-zinc-500 truncate max-w-[60%]">→ {selectedTitle}</p>
            ) : (
              <p className="text-xs text-zinc-400">{allChats.length} чатов</p>
            )}
            <div className="flex gap-2">
              <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-500 hover:bg-zinc-100 transition-colors">Отмена</button>
              <button onClick={handleForward} disabled={!selectedChat || sending}
                className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors">
                {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}Передать
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── List Item (left panel) ─────────────────────────────────────────────────── */

function ListItem({
  item, active, onClick,
}: {
  item: LeadQualification; active: boolean; onClick: () => void;
}) {
  const m = STATUS_META[item.status] ?? STATUS_META.error;
  const date = item.reply_timestamp ?? item.created_at;
  const isUnread = !item.read_at;

  return (
    <button
      onClick={onClick}
      className={`
        w-full text-left border-l-[3px] transition-all duration-150 relative
        ${m.border}
        ${active
          ? 'bg-zinc-100'
          : isUnread
            ? 'bg-blue-50/60 hover:bg-blue-50'
            : 'bg-zinc-50/40 hover:bg-zinc-50'
        }
      `}
    >
      {isUnread && (
        <div className="absolute inset-y-0 right-0 w-1 bg-blue-500 rounded-l" />
      )}
      <div className="px-4 py-3">
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="flex items-center gap-2 min-w-0">
            {isUnread && (
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-40" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500" />
              </span>
            )}
            <span className={`text-sm truncate ${isUnread ? 'font-bold text-zinc-900' : 'font-normal text-zinc-500'}`}>
              {item.lead_name || item.lead_email}
            </span>
          </div>
          <span className={`text-[10px] tabular-nums shrink-0 ${isUnread ? 'text-blue-500 font-semibold' : 'text-zinc-400'}`}>
            {formatDate(date)}
          </span>
        </div>

        {item.company_name && (
          <p className={`text-[11px] truncate mb-1 ${isUnread ? 'text-zinc-500' : 'text-zinc-400'}`}>{item.company_name}</p>
        )}

        <p className={`text-xs truncate ${isUnread ? 'text-zinc-600 font-medium' : 'text-zinc-400'}`}>
          {item.reply_preview ?? item.reply_subject ?? ''}
        </p>

        <div className="mt-1.5 flex items-center gap-2">
          <StatusBadge status={item.status} size="sm" />
          {isUnread && (
            <span className="text-[9px] font-bold uppercase tracking-wider text-blue-500">новое</span>
          )}
        </div>
      </div>
    </button>
  );
}

/* ─── Detail Panel (right panel) ─────────────────────────────────────────────── */

function DetailPanel({ item, onRefresh }: { item: LeadQualification; onRefresh: () => void }) {
  const [showForward, setShowForward] = useState(false);
  const [copied, setCopied] = useState(false);
  const m = STATUS_META[item.status] ?? STATUS_META.error;
  const canForward = item.status === 'lead' || item.status === 'objection' || item.status === 'needs_review';

  const handleCopyDraft = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* noop */ }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-zinc-200 px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3 mb-2">
              <h2 className="text-lg font-bold text-zinc-900 truncate">
                {item.lead_name || item.lead_email}
              </h2>
              <StatusBadge status={item.status} size="lg" />
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
              <span className="inline-flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5 text-zinc-400" />
                {item.lead_email}
              </span>
              {item.company_name && (
                <span className="inline-flex items-center gap-1.5">
                  <Building2 className="h-3.5 w-3.5 text-zinc-400" />
                  {item.company_name}
                </span>
              )}
              <span className="inline-flex items-center gap-1.5">
                <Tag className="h-3.5 w-3.5 text-zinc-400" />
                {item.campaign_name ?? item.campaign_id.slice(0, 8)}
              </span>
            </div>
          </div>
          {item.ai_confidence !== null && (
            <div className="shrink-0 text-right">
              <ConfidenceBar value={item.ai_confidence} />
            </div>
          )}
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

        {/* AI Analysis */}
        {item.ai_reason && (
          <section className="rounded-xl border border-zinc-200/80 bg-gradient-to-br from-zinc-50 to-white p-5">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="h-4 w-4 text-amber-500" />
              <span className="text-sm font-bold text-zinc-700">AI-анализ</span>
            </div>
            <p className="text-sm text-zinc-700 leading-relaxed">{item.ai_reason}</p>
            {item.interest_signals && item.interest_signals.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {item.interest_signals.map((s, i) => (
                  <span key={i} className="rounded-md bg-emerald-50 ring-1 ring-emerald-200 px-2 py-0.5 text-[11px] font-medium text-emerald-700">{s}</span>
                ))}
              </div>
            )}
            <div className="mt-3 flex items-center gap-4 text-[11px] text-zinc-400">
              <span className="inline-flex items-center gap-1">
                <CircleDot className="h-3 w-3" />
                Предложение: {item.proposal_seen ? 'видели' : 'не видели'}
              </span>
            </div>
          </section>
        )}

        {/* Error */}
        {item.error_message && (
          <section className="rounded-xl border border-red-200 bg-red-50/50 p-4">
            <p className="text-xs font-semibold text-red-600 mb-1">Ошибка квалификации</p>
            <p className="text-sm text-red-700">{item.error_message}</p>
          </section>
        )}

        {/* Conversation (chat bubbles) */}
        <section>
          <p className="text-xs font-bold text-zinc-500 uppercase tracking-wide mb-3">Переписка</p>
          <div className="space-y-3">
            {item.last_outbound_preview && (
              <div className="flex justify-start">
                <div className="max-w-[85%]">
                  <p className="text-[10px] text-zinc-400 mb-1 ml-1">Наше письмо</p>
                  <div className="rounded-2xl rounded-tl-md bg-zinc-100 px-4 py-3 text-sm text-zinc-600 leading-relaxed whitespace-pre-wrap max-h-[400px] overflow-y-auto">
                    {item.last_outbound_preview}
                  </div>
                </div>
              </div>
            )}
            <div className="flex justify-end">
              <div className="max-w-[85%]">
                <p className="text-[10px] text-zinc-400 mb-1 mr-1 text-right">
                  Ответ{item.reply_subject ? ` · ${item.reply_subject}` : ''}
                  {item.reply_timestamp && (
                    <span className="ml-2 tabular-nums">
                      {new Date(item.reply_timestamp).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </p>
                <div className={`rounded-2xl rounded-tr-md px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap max-h-[500px] overflow-y-auto ${
                  item.status === 'lead' ? 'bg-emerald-50 text-emerald-900 ring-1 ring-emerald-200/60' :
                  item.status === 'objection' ? 'bg-violet-50 text-violet-900 ring-1 ring-violet-200/60' :
                  'bg-blue-50 text-zinc-800 ring-1 ring-blue-200/60'
                }`}>
                  {item.reply_body ?? item.reply_preview ?? '(пусто)'}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Objection draft */}
        {item.objection_handleable && item.objection_draft && (
          <section className="rounded-xl border border-violet-200/80 bg-gradient-to-br from-violet-50 to-white p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-1.5">
                <MessageSquare className="h-4 w-4 text-violet-500" />
                <span className="text-sm font-bold text-violet-700">Черновик ответа на возражение</span>
              </div>
              <button onClick={() => handleCopyDraft(item.objection_draft!)}
                className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium text-violet-500 hover:bg-violet-100 transition-colors">
                {copied ? <CheckCircle2 className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? 'Скопировано' : 'Копировать'}
              </button>
            </div>
            <p className="text-sm text-zinc-700 leading-relaxed whitespace-pre-wrap">{item.objection_draft}</p>
          </section>
        )}

        {/* Forward dialog */}
        {showForward && (
          <ForwardToClientDialog
            qualificationId={item.id}
            onClose={() => setShowForward(false)}
            onForwarded={() => { setShowForward(false); onRefresh(); }}
          />
        )}
      </div>

      {/* Actions footer */}
      <div className="sticky bottom-0 z-10 border-t border-zinc-200 bg-white px-6 py-3 flex items-center gap-3">
        <Link
          href={`/instantly/emails?campaign_id=${item.campaign_id}` as Route}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50 transition-colors"
        >
          <Mail className="h-3.5 w-3.5" />
          Все письма
          <ArrowUpRight className="h-3 w-3 text-zinc-400" />
        </Link>
        {canForward && (
          <button
            onClick={() => setShowForward(!showForward)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-500 transition-colors"
          >
            <Send className="h-3.5 w-3.5" />
            Передать клиенту
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── Main Page ──────────────────────────────────────────────────────────────── */

export default function IncomingLeadsPage() {
  const [items, setItems] = useState<LeadQualification[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
      const params = new URLSearchParams({ status: statusFilter, limit: String(LIMIT), offset: String(offset) });
      if (campaignId) params.set('campaign_id', campaignId);
      if (search) params.set('search', search);
      if (!campaignId) params.set('use_preferences', 'true');

      const data = await fetchWithAuth<QualifiedLeadsResponse>(`/api/instantly/qualified-leads?${params.toString()}`);
      setItems(data.items);
      setTotal(data.total);
      if (data.counts) setCounts(data.counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, campaignId, search, offset]);

  useEffect(() => { loadData(); }, [loadData]);

  const markAsRead = useCallback(async (id: string) => {
    if (readIdsRef.current.has(id)) return;
    readIdsRef.current.add(id);
    setItems(prev => prev.map(item => item.id === id ? { ...item, read_at: new Date().toISOString() } : item));
    try {
      await fetchWithAuth('/api/instantly/qualified-leads', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      });
    } catch { readIdsRef.current.delete(id); }
  }, []);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    const item = items.find(i => i.id === id);
    if (item && !item.read_at) markAsRead(id);
  }, [items, markAsRead]);

  const handleSearch = () => { setOffset(0); loadData(); };

  const selectedItem = items.find(i => i.id === selectedId) ?? null;
  const hasMore = offset + LIMIT < total;
  const unreadCount = items.filter(i => !i.read_at).length;
  const totalAll = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="flex flex-col h-screen">
      {/* Top bar */}
      <div className="shrink-0 border-b border-zinc-200 bg-white px-6 pt-5 pb-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-4">
            <Link href={'/instantly' as Route} className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors">
              <ChevronLeft className="h-4 w-4" />
            </Link>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold text-zinc-900">Входящие лиды</h1>
                {unreadCount > 0 && (
                  <span className="inline-flex items-center justify-center h-5 min-w-5 px-1.5 rounded-full bg-blue-500 text-[10px] font-bold text-white tabular-nums">
                    {unreadCount}
                  </span>
                )}
              </div>
              <p className="text-xs text-zinc-400 mt-0.5">AI-квалификация ответов по кампаниям Instantly</p>
            </div>
          </div>
        </div>

        {/* Filters row */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Status tabs with counters */}
          <div className="flex rounded-lg border border-zinc-200 bg-white overflow-hidden">
            {STATUS_FILTERS.map((f) => {
              const cnt = f.value === 'all' ? totalAll : (counts[f.value] ?? 0);
              return (
                <button
                  key={f.value}
                  onClick={() => { setStatusFilter(f.value); setOffset(0); setSelectedId(null); }}
                  className={`px-3 py-1.5 text-xs font-semibold transition-all duration-150 ${
                    statusFilter === f.value
                      ? 'bg-zinc-900 text-white'
                      : 'text-zinc-500 hover:bg-zinc-50 hover:text-zinc-700'
                  }`}
                >
                  {f.label}
                  {cnt > 0 && <span className="ml-1 opacity-70">({cnt})</span>}
                </button>
              );
            })}
          </div>

          <select
            value={campaignId}
            onChange={(e) => { setCampaignId(e.target.value); setOffset(0); setSelectedId(null); }}
            className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs focus:border-zinc-400 focus:outline-none max-w-[220px]"
            disabled={campaignsLoading}
          >
            <option value="">Мои кампании</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>

          <div className="relative min-w-[160px] max-w-[240px]">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-300" />
            <input
              type="text"
              placeholder="Поиск..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="w-full rounded-lg border border-zinc-200 bg-white py-1.5 pl-8 pr-3 text-xs focus:border-zinc-400 focus:outline-none placeholder:text-zinc-300"
            />
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="shrink-0 mx-6 mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600 font-medium">{error}</div>
      )}

      {/* Main content: split pane */}
      <div className="flex-1 min-h-0 grid grid-cols-[minmax(320px,2fr)_3fr]">
        {/* Left: list */}
        <div className="border-r border-zinc-200 flex flex-col bg-white">
          <div className="flex-1 overflow-y-auto divide-y divide-zinc-100">
            {loading && items.length === 0 ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-5 w-5 animate-spin text-zinc-300" />
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 px-4 text-center">
                <Eye className="h-8 w-8 text-zinc-200 mb-3" />
                <p className="text-sm text-zinc-500">Ничего не найдено</p>
                <p className="text-xs text-zinc-400 mt-1">Воркер проверяет новые ответы каждые 30 сек</p>
              </div>
            ) : (
              items.map((item) => (
                <ListItem
                  key={item.id}
                  item={item}
                  active={selectedId === item.id}
                  onClick={() => handleSelect(item.id)}
                />
              ))
            )}
          </div>

          {/* Pagination */}
          {items.length > 0 && (
            <div className="shrink-0 border-t border-zinc-100 px-4 py-2 flex items-center justify-between">
              <button onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0}
                className="text-[11px] font-medium text-zinc-400 hover:text-zinc-700 disabled:opacity-30 transition-colors inline-flex items-center gap-0.5">
                <ChevronLeft className="h-3 w-3" />Назад
              </button>
              <span className="text-[10px] text-zinc-400 tabular-nums">{offset + 1}–{Math.min(offset + LIMIT, total)} / {total}</span>
              <button onClick={() => hasMore && setOffset(offset + LIMIT)} disabled={!hasMore}
                className="text-[11px] font-medium text-zinc-400 hover:text-zinc-700 disabled:opacity-30 transition-colors inline-flex items-center gap-0.5">
                Далее<ChevronRight className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>

        {/* Right: detail */}
        <div className="bg-white overflow-y-auto">
          {selectedItem ? (
            <DetailPanel item={selectedItem} onRefresh={loadData} />
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-center px-8">
              <div className="h-16 w-16 rounded-2xl bg-zinc-100 flex items-center justify-center mb-4">
                <User className="h-7 w-7 text-zinc-300" />
              </div>
              <p className="text-sm font-medium text-zinc-500">Выберите лид из списка</p>
              <p className="text-xs text-zinc-400 mt-1 max-w-xs">
                Кликните на строку слева, чтобы увидеть AI-анализ, переписку и действия
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
