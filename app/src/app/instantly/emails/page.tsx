'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  ChevronLeft, ChevronRight, Loader2, Mail, Send, Reply, Search, Inbox, X,
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

function CampaignCombobox({
  campaigns,
  value,
  onChange,
}: {
  campaigns: Campaign[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedName = campaigns.find((c) => c.id === value)?.name ?? '';

  const filtered = query
    ? campaigns.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
    : campaigns;

  useEffect(() => { setHighlightIdx(0); }, [query]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        if (!value) setQuery('');
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [value]);

  useEffect(() => {
    if (open && listRef.current) {
      const el = listRef.current.children[highlightIdx] as HTMLElement | undefined;
      el?.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightIdx, open]);

  function select(id: string) {
    onChange(id);
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open && e.key !== 'Escape') { setOpen(true); return; }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightIdx((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightIdx((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (filtered[highlightIdx]) select(filtered[highlightIdx].id);
        break;
      case 'Escape':
        setOpen(false);
        inputRef.current?.blur();
        break;
    }
  }

  return (
    <div ref={containerRef} className="relative min-w-[320px]">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
        <input
          ref={inputRef}
          type="text"
          value={open ? query : (query || selectedName)}
          placeholder="Поиск кампании…"
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => { setOpen(true); setQuery(''); }}
          onKeyDown={handleKeyDown}
          className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-8 text-sm focus:border-zinc-400 focus:outline-none"
        />
        {value && !open && (
          <button
            onClick={() => { onChange(''); setQuery(''); inputRef.current?.focus(); }}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {open && (
        <ul
          ref={listRef}
          className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-zinc-200 bg-white py-1 shadow-lg"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-sm text-zinc-400">Ничего не найдено</li>
          ) : (
            filtered.map((c, idx) => (
              <li
                key={c.id}
                onMouseDown={() => select(c.id)}
                onMouseEnter={() => setHighlightIdx(idx)}
                className={`cursor-pointer px-3 py-2 text-sm transition-colors ${
                  idx === highlightIdx ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-700 hover:bg-zinc-50'
                } ${c.id === value ? 'font-medium' : ''}`}
              >
                {c.name}
              </li>
            ))
          )}
        </ul>
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
        <CampaignCombobox
          campaigns={campaigns}
          value={campaignId}
          onChange={setCampaignId}
        />

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
