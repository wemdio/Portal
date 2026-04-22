'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  ChevronLeft, Loader2, Plus, Trash2, FileText, Link2, Upload, X, Check,
} from 'lucide-react';
import { instantlyFetch } from '@/lib/instantly/fetcher';
import { authFetchJson, getAccessToken } from '@/lib/authFetch';
import type { Campaign, PaginatedResponse } from '@/lib/instantly/types';

type BriefCampaign = { id: string; campaign_id: string };
type Brief = {
  id: string;
  name: string;
  brief_text: string;
  file_name: string | null;
  uploaded_by: string;
  created_at: string;
  instantly_brief_campaigns: BriefCampaign[];
};

function CampaignSelector({
  campaigns,
  selected,
  onSave,
  onCancel,
}: {
  campaigns: { id: string; name: string }[];
  selected: string[];
  onSave: (ids: string[]) => void;
  onCancel: () => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set(selected));
  const [filter, setFilter] = useState('');

  const toggle = (id: string) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChecked(next);
  };

  const filtered = campaigns.filter(
    (c) => c.name.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="mt-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm animate-in fade-in slide-in-from-top-1 duration-200">
      <input
        type="text"
        placeholder="Поиск кампании..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-zinc-200 focus:border-zinc-400 placeholder:text-zinc-300"
      />
      <div className="max-h-56 overflow-y-auto space-y-0.5">
        {filtered.length === 0 && (
          <p className="text-xs text-zinc-400 py-3 text-center">Кампании не найдены</p>
        )}
        {filtered.map((c) => (
          <label key={c.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-50 cursor-pointer transition-colors">
            <input
              type="checkbox"
              checked={checked.has(c.id)}
              onChange={() => toggle(c.id)}
              className="h-4 w-4 rounded border-zinc-300 text-zinc-800 focus:ring-zinc-300"
            />
            <span className="text-sm text-zinc-700 truncate">{c.name}</span>
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2 pt-2 border-t border-zinc-100">
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-500 hover:bg-zinc-100 transition-colors"
        >
          <X className="h-3 w-3" /> Отмена
        </button>
        <button
          onClick={() => onSave([...checked])}
          className="inline-flex items-center gap-1 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 transition-colors"
        >
          <Check className="h-3 w-3" /> Сохранить ({checked.size})
        </button>
      </div>
    </div>
  );
}

function BriefCard({
  brief,
  campaigns,
  onDelete,
  onCampaignsUpdated,
}: {
  brief: Brief;
  campaigns: { id: string; name: string }[];
  onDelete: (id: string) => void;
  onCampaignsUpdated: () => void;
}) {
  const [showSelector, setShowSelector] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showText, setShowText] = useState(false);

  const linkedCampaignIds = brief.instantly_brief_campaigns.map((bc) => bc.campaign_id);
  const linkedCampaignNames = linkedCampaignIds
    .map((cid) => campaigns.find((c) => c.id === cid)?.name ?? cid.slice(0, 8))
    .slice(0, 5);

  const handleSaveCampaigns = async (ids: string[]) => {
    setSaving(true);
    try {
      await authFetchJson(`/api/instantly/briefs/${brief.id}/campaigns`, {
        method: 'PUT',
        body: JSON.stringify({ campaign_ids: ids }),
      });
      onCampaignsUpdated();
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
      setShowSelector(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Удалить бриф?')) return;
    setDeleting(true);
    try {
      await authFetchJson(`/api/instantly/briefs/${brief.id}`, { method: 'DELETE' });
      onDelete(brief.id);
    } catch (err) {
      console.error(err);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="h-9 w-9 rounded-lg bg-zinc-100 flex items-center justify-center shrink-0">
            <FileText className="h-4.5 w-4.5 text-zinc-500" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-900 truncate">{brief.name}</h3>
            <p className="text-[11px] text-zinc-400">
              {brief.file_name ?? 'Текстовый бриф'}
              <span className="mx-1.5">·</span>
              {new Date(brief.created_at).toLocaleDateString('ru-RU')}
            </p>
          </div>
        </div>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="rounded-lg p-1.5 text-zinc-300 hover:text-red-500 hover:bg-red-50 transition-colors"
          title="Удалить бриф"
        >
          {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </button>
      </div>

      <button
        onClick={() => setShowText(!showText)}
        className="text-[11px] font-medium text-zinc-400 hover:text-zinc-600 mb-3 transition-colors"
      >
        {showText ? 'Скрыть текст' : 'Показать текст брифа'}
      </button>
      {showText && (
        <div className="mb-3 rounded-xl border border-zinc-100 bg-zinc-50/50 p-3 text-xs text-zinc-600 whitespace-pre-wrap max-h-48 overflow-y-auto leading-relaxed animate-in fade-in duration-200">
          {brief.brief_text.slice(0, 3000)}
          {brief.brief_text.length > 3000 && <span className="text-zinc-400">...</span>}
        </div>
      )}

      <div className="border-t border-zinc-100 pt-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <Link2 className="h-3.5 w-3.5 text-zinc-400" />
            <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wide">
              Кампании ({linkedCampaignIds.length})
            </span>
          </div>
          <button
            onClick={() => setShowSelector(!showSelector)}
            disabled={saving}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-400 hover:text-zinc-700 transition-colors"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            Изменить
          </button>
        </div>

        {linkedCampaignNames.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {linkedCampaignNames.map((name, i) => (
              <span
                key={i}
                className="rounded-md bg-zinc-100 ring-1 ring-zinc-200 px-2 py-0.5 text-[11px] font-medium text-zinc-600 truncate max-w-[200px]"
              >
                {name}
              </span>
            ))}
            {linkedCampaignIds.length > 5 && (
              <span className="text-[11px] text-zinc-400">+{linkedCampaignIds.length - 5}</span>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-zinc-400">Кампании не привязаны</p>
        )}

        {showSelector && (
          <CampaignSelector
            campaigns={campaigns}
            selected={linkedCampaignIds}
            onSave={handleSaveCampaigns}
            onCancel={() => setShowSelector(false)}
          />
        )}
      </div>
    </div>
  );
}

export default function BriefsPage() {
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>([]);

  const [showUpload, setShowUpload] = useState(false);
  const [uploadName, setUploadName] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');

  const loadBriefs = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await authFetchJson<{ items: Brief[] }>('/api/instantly/briefs');
      setBriefs(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBriefs();
    instantlyFetch<PaginatedResponse<Campaign>>('/campaigns?limit=all')
      .then((res) => setCampaigns((res.items ?? []).map((c) => ({ id: c.id, name: c.name }))))
      .catch(() => setCampaigns([]));
  }, [loadBriefs]);

  const handleUpload = async () => {
    if (!uploadName.trim()) {
      setUploadError('Введите название клиента');
      return;
    }
    if (!uploadFile) {
      setUploadError('Выберите PDF файл');
      return;
    }

    setUploading(true);
    setUploadError('');

    try {
      const formData = new FormData();
      formData.append('name', uploadName.trim());
      formData.append('file', uploadFile);

      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');

      const res = await fetch('/api/instantly/briefs', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body?.error ?? `Error ${res.status}`);
      }

      setUploadName('');
      setUploadFile(null);
      setShowUpload(false);
      loadBriefs();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = (id: string) => {
    setBriefs((prev) => prev.filter((b) => b.id !== id));
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <Link
        href={'/instantly' as Route}
        className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 mb-4 transition-colors"
      >
        <ChevronLeft className="h-3 w-3" /> Instantly
      </Link>

      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 tracking-tight">Брифы клиентов</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Загрузите бриф и привяжите к кампаниям для AI-обработки возражений
          </p>
        </div>
        <button
          onClick={() => setShowUpload(!showUpload)}
          className="inline-flex items-center gap-1.5 rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 transition-colors shadow-sm"
        >
          <Upload className="h-4 w-4" />
          Загрузить бриф
        </button>
      </div>

      {showUpload && (
        <div className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm animate-in fade-in slide-in-from-top-2 duration-200">
          <h3 className="text-sm font-semibold text-zinc-900 mb-4">Новый бриф</h3>

          <div className="space-y-4">
            <div>
              <label className="text-xs font-medium text-zinc-600 mb-1 block">Название клиента</label>
              <input
                type="text"
                value={uploadName}
                onChange={(e) => setUploadName(e.target.value)}
                placeholder="Например: Компания XYZ"
                className="w-full rounded-xl border border-zinc-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-200 focus:border-zinc-400 placeholder:text-zinc-300"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-zinc-600 mb-1 block">Бриф (PDF)</label>
              <div className="relative">
                <input
                  type="file"
                  accept=".pdf"
                  onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                  className="w-full rounded-xl border border-zinc-200 px-3 py-2.5 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-100 file:px-3 file:py-1 file:text-xs file:font-medium file:text-zinc-700 file:cursor-pointer hover:file:bg-zinc-200 transition-all focus:outline-none focus:ring-2 focus:ring-zinc-200"
                />
              </div>
              {uploadFile && (
                <p className="mt-1 text-[11px] text-zinc-400">{uploadFile.name} ({(uploadFile.size / 1024).toFixed(0)} KB)</p>
              )}
            </div>

            {uploadError && (
              <p className="text-xs text-red-500 font-medium">{uploadError}</p>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={() => { setShowUpload(false); setUploadError(''); }}
                className="rounded-xl px-4 py-2 text-xs font-medium text-zinc-500 hover:bg-zinc-100 transition-colors"
              >
                Отмена
              </button>
              <button
                onClick={handleUpload}
                disabled={uploading}
                className="inline-flex items-center gap-1.5 rounded-xl bg-zinc-900 px-4 py-2 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50 transition-colors"
              >
                {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                Загрузить
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600 font-medium">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-300" />
        </div>
      ) : briefs.length === 0 ? (
        <div className="rounded-2xl border border-zinc-200 bg-white py-20 text-center shadow-sm">
          <div className="mx-auto h-12 w-12 rounded-full bg-zinc-100 flex items-center justify-center mb-4">
            <FileText className="h-6 w-6 text-zinc-300" />
          </div>
          <p className="text-sm font-medium text-zinc-600">Брифов пока нет</p>
          <p className="mt-1.5 text-xs text-zinc-400 max-w-sm mx-auto">
            Загрузите PDF с брифом клиента и привяжите к кампаниям — AI будет использовать его для обработки возражений
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {briefs.map((brief) => (
            <BriefCard
              key={brief.id}
              brief={brief}
              campaigns={campaigns}
              onDelete={handleDelete}
              onCampaignsUpdated={loadBriefs}
            />
          ))}
        </div>
      )}
    </div>
  );
}
