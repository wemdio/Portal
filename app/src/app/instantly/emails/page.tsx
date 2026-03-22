'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  ChevronLeft, ChevronRight, Loader2, Mail, Send, Reply, Search, Inbox,
} from 'lucide-react';
import { instantlyFetch } from '@/lib/instantly/fetcher';
import type { Email, Campaign, PaginatedResponse } from '@/lib/instantly/types';

const UE_TYPE_CONFIG: Record<number, { label: string; icon: React.ElementType; cls: string }> = {
  1: { label: 'Отправлено', icon: Send, cls: 'text-blue-600 bg-blue-50' },
  2: { label: 'Ответ', icon: Reply, cls: 'text-emerald-600 bg-emerald-50' },
  3: { label: 'Наш ответ', icon: Reply, cls: 'text-violet-600 bg-violet-50' },
};

function getBodyText(body: Email['body']): string {
  if (!body) return '';
  if (typeof body === 'string') return body;
  if (body.text) return body.text;
  if (body.html) {
    return body.html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .trim();
  }
  return '';
}

function EmailRow({ email, expanded, onToggle }: { email: Email; expanded: boolean; onToggle: () => void }) {
  const config = UE_TYPE_CONFIG[email.ue_type ?? 1] ?? UE_TYPE_CONFIG[1];
  const Icon = config.icon;
  const isReply = (email.ue_type ?? 1) >= 2;
  const fromName = email.from_address_json?.[0]?.name;
  const fromEmail = email.from_address_email ?? '';
  const toEmail = email.to_address_email_list ?? '';
  const date = email.timestamp_email ?? email.timestamp_created;

  return (
    <div className={`border-b border-zinc-100 ${email.is_unread ? 'bg-blue-50/30' : ''}`}>
      <button
        onClick={onToggle}
        className="w-full text-left px-5 py-3.5 hover:bg-zinc-50 transition-colors"
      >
        <div className="flex items-start gap-3">
          <div className={`mt-0.5 shrink-0 rounded-md p-1.5 ${config.cls}`}>
            <Icon className="h-3.5 w-3.5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-0.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`text-sm font-medium truncate ${email.is_unread ? 'text-zinc-900' : 'text-zinc-700'}`}>
                  {isReply ? (fromName || fromEmail) : toEmail}
                </span>
                {isReply && (
                  <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                    ответ
                  </span>
                )}
              </div>
              <span className="shrink-0 text-xs text-zinc-400">
                {date ? new Date(date).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
              </span>
            </div>
            <p className={`text-sm truncate ${email.is_unread ? 'font-medium text-zinc-800' : 'text-zinc-600'}`}>
              {email.subject || '(без темы)'}
            </p>
            {!expanded && (
              <p className="text-xs text-zinc-400 truncate mt-0.5">
                {email.content_preview || getBodyText(email.body).slice(0, 120)}
              </p>
            )}
          </div>
        </div>
      </button>
      {expanded && (
        <div className="px-5 pb-4 pt-1">
          <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-400">
            <span>От: <span className="text-zinc-600">{fromName ? `${fromName} <${fromEmail}>` : fromEmail}</span></span>
            <span>Кому: <span className="text-zinc-600">{toEmail}</span></span>
            {email.eaccount && email.eaccount !== fromEmail && (
              <span>Аккаунт: <span className="text-zinc-600">{email.eaccount}</span></span>
            )}
          </div>
          <div className="rounded-lg border border-zinc-100 bg-zinc-50/50 p-4 text-sm text-zinc-700 whitespace-pre-wrap max-h-80 overflow-y-auto leading-relaxed">
            {getBodyText(email.body)}
          </div>
        </div>
      )}
    </div>
  );
}

export default function EmailsPage() {
  const [emails, setEmails] = useState<Email[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [startingAfter, setStartingAfter] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<'' | '2'>('');

  useEffect(() => {
    instantlyFetch<{ items: Campaign[] }>('/campaigns?limit=all')
      .then((d) => setCampaigns(d.items ?? []))
      .catch(() => {});
  }, []);

  const loadEmails = useCallback(async (append = false) => {
    if (!campaignId) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ campaign_id: campaignId, limit: '25' });
      if (append && startingAfter) params.set('starting_after', startingAfter);
      const data = await instantlyFetch<PaginatedResponse<Email>>(`/emails?${params}`);
      const items = data.items ?? [];
      setEmails(append ? (prev) => [...prev, ...items] : items);
      setStartingAfter(data.next_starting_after);
      setHasMore(!!data.next_starting_after);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setLoading(false);
    }
  }, [campaignId, startingAfter]);

  useEffect(() => {
    if (campaignId) {
      setEmails([]);
      setStartingAfter(undefined);
      setExpandedId(null);
      loadEmails();
    }
  }, [campaignId]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = typeFilter
    ? emails.filter((e) => e.ue_type === Number(typeFilter))
    : emails;

  const repliesCount = emails.filter((e) => (e.ue_type ?? 0) >= 2).length;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <Link href={'/instantly' as Route} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 mb-3 transition-colors">
        <ChevronLeft className="h-3 w-3" /> Instantly
      </Link>
      <h1 className="mb-2 text-2xl font-bold text-zinc-900">Письма</h1>
      <p className="mb-6 text-sm text-zinc-500">Входящие и исходящие письма по кампаниям</p>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <select
          value={campaignId}
          onChange={(e) => setCampaignId(e.target.value)}
          className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none min-w-[200px]"
        >
          <option value="">Выберите кампанию</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        {emails.length > 0 && (
          <div className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-white p-0.5">
            <button
              onClick={() => setTypeFilter('')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                !typeFilter ? 'bg-zinc-900 text-white' : 'text-zinc-500 hover:text-zinc-900'
              }`}
            >
              Все ({emails.length})
            </button>
            <button
              onClick={() => setTypeFilter('2')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                typeFilter === '2' ? 'bg-zinc-900 text-white' : 'text-zinc-500 hover:text-zinc-900'
              }`}
            >
              Ответы ({repliesCount})
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {!campaignId ? (
        <div className="rounded-xl border border-zinc-200 bg-white py-16 text-center">
          <Inbox className="mx-auto h-8 w-8 text-zinc-300" />
          <p className="mt-3 text-sm text-zinc-500">Выберите кампанию для просмотра писем</p>
        </div>
      ) : loading && emails.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white py-16 text-center">
          <Mail className="mx-auto h-8 w-8 text-zinc-300" />
          <p className="mt-3 text-sm text-zinc-500">
            {typeFilter ? 'Нет ответов' : 'Нет писем в этой кампании'}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
          {filtered.map((email) => (
            <EmailRow
              key={email.id}
              email={email}
              expanded={expandedId === email.id}
              onToggle={() => setExpandedId(expandedId === email.id ? null : email.id)}
            />
          ))}
          <div className="border-t border-zinc-100 px-5 py-3 flex items-center justify-between">
            <span className="text-xs text-zinc-400">
              {filtered.length} {typeFilter ? 'ответов' : 'писем'} загружено
            </span>
            {hasMore && !typeFilter && (
              <button
                onClick={() => loadEmails(true)}
                disabled={loading}
                className="inline-flex items-center gap-1 text-xs font-medium text-zinc-600 hover:text-zinc-900 disabled:opacity-50 transition-colors"
              >
                {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ChevronRight className="h-3 w-3" />}
                Загрузить ещё
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
