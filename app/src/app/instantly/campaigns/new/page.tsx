'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Route } from 'next';
import {
  ChevronLeft, Loader2, Send, Plus, Trash2, Clock, Mail,
} from 'lucide-react';
import { instantlyFetch } from '@/lib/instantly/fetcher';
import type { Account, Campaign, CampaignCreatePayload, PaginatedResponse } from '@/lib/instantly/types';

const DEFAULT_SCHEDULE = {
  schedules: [
    {
      name: 'Default',
      timing: { from: '09:00', to: '17:00' },
      days: { 0: false, 1: true, 2: true, 3: true, 4: true, 5: true, 6: false },
      timezone: 'Europe/Moscow',
    },
  ],
  start_date: null,
  end_date: null,
};

interface StepDraft {
  subject: string;
  body: string;
  wait_days: number;
}

export default function CreateCampaignPage() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const [name, setName] = useState('');
  const [dailyLimit, setDailyLimit] = useState('50');
  const [dailyMaxLeads, setDailyMaxLeads] = useState('50');
  const [emailGap, setEmailGap] = useState('10');
  const [stopOnReply, setStopOnReply] = useState(true);
  const [openTracking, setOpenTracking] = useState(true);
  const [linkTracking, setLinkTracking] = useState(true);
  const [textOnly, setTextOnly] = useState(false);

  const [steps, setSteps] = useState<StepDraft[]>([
    { subject: '', body: '', wait_days: 0 },
  ]);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);

  const [scheduleFrom, setScheduleFrom] = useState('09:00');
  const [scheduleTo, setScheduleTo] = useState('17:00');
  const [scheduleDays, setScheduleDays] = useState<Record<string, boolean>>({
    '0': false, '1': true, '2': true, '3': true, '4': true, '5': true, '6': false,
  });

  useEffect(() => {
    instantlyFetch<{ items: Account[] }>('/accounts?limit=all')
      .then((d) => setAccounts(d.items ?? []))
      .catch(() => {})
      .finally(() => setLoadingAccounts(false));
  }, []);

  const addStep = () => {
    setSteps((prev) => [...prev, { subject: '', body: '', wait_days: 2 }]);
  };

  const removeStep = (index: number) => {
    if (steps.length <= 1) return;
    setSteps((prev) => prev.filter((_, i) => i !== index));
  };

  const updateStep = (index: number, field: keyof StepDraft, value: string | number) => {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)));
  };

  const toggleAccount = (email: string) => {
    setSelectedAccounts((prev) =>
      prev.includes(email) ? prev.filter((e) => e !== email) : [...prev, email],
    );
  };

  const handleCreate = useCallback(async () => {
    if (!name.trim()) { setError('Введите название кампании'); return; }
    if (steps.some((s) => !s.subject.trim() && !s.body.trim())) {
      setError('Заполните тему или тело хотя бы для каждого шага');
      return;
    }

    setCreating(true);
    setError('');

    const payload: CampaignCreatePayload = {
      name: name.trim(),
      campaign_schedule: {
        schedules: [{
          name: 'Default',
          timing: { from: scheduleFrom, to: scheduleTo },
          days: Object.fromEntries(Object.entries(scheduleDays).map(([k, v]) => [k, v])) as Record<string, boolean>,
          timezone: 'Europe/Moscow',
        }],
      },
      sequences: [{
        steps: steps.map((s) => ({
          subject: s.subject,
          body: s.body,
          wait_days: s.wait_days,
        })),
      }],
      email_list: selectedAccounts.length > 0 ? selectedAccounts : undefined,
      daily_limit: dailyLimit ? Number(dailyLimit) : undefined,
      daily_max_leads: dailyMaxLeads ? Number(dailyMaxLeads) : undefined,
      email_gap: emailGap ? Number(emailGap) : undefined,
      stop_on_reply: stopOnReply,
      open_tracking: openTracking,
      link_tracking: linkTracking,
      text_only: textOnly,
    };

    try {
      const campaign = await instantlyFetch<Campaign>('/campaigns', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      router.push(`/instantly/campaigns/${campaign.id}` as Route);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка создания');
    } finally {
      setCreating(false);
    }
  }, [name, steps, selectedAccounts, dailyLimit, dailyMaxLeads, emailGap, stopOnReply, openTracking, linkTracking, textOnly, scheduleFrom, scheduleTo, scheduleDays, router]);

  const DAY_NAMES = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <Link href={'/instantly/campaigns' as Route} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 mb-4 transition-colors">
        <ChevronLeft className="h-3 w-3" /> Кампании
      </Link>

      <h1 className="mb-6 text-2xl font-bold text-zinc-900">Создать кампанию</h1>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      <div className="space-y-6">
        {/* Name */}
        <div className="rounded-xl border border-zinc-200 bg-white p-5">
          <label className="mb-2 block text-sm font-semibold text-zinc-900">Название кампании</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Например: Cold outreach - SaaS founders Q1 2026"
            className="w-full rounded-lg border border-zinc-200 px-3 py-2.5 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400"
          />
        </div>

        {/* Steps/Sequences */}
        <div className="rounded-xl border border-zinc-200 bg-white p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-900">Письма</h2>
            <button
              onClick={addStep}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 transition-colors"
            >
              <Plus className="h-3 w-3" /> Добавить шаг
            </button>
          </div>
          <div className="space-y-4">
            {steps.map((step, i) => (
              <div key={i} className="rounded-lg border border-zinc-100 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-xs font-medium text-zinc-500">Шаг {i + 1}</span>
                  <div className="flex items-center gap-3">
                    {i > 0 && (
                      <div className="flex items-center gap-1.5">
                        <Clock className="h-3 w-3 text-zinc-400" />
                        <input
                          type="number"
                          min={0}
                          value={step.wait_days}
                          onChange={(e) => updateStep(i, 'wait_days', Number(e.target.value))}
                          className="w-14 rounded border border-zinc-200 px-2 py-1 text-xs text-center focus:border-zinc-400 focus:outline-none"
                        />
                        <span className="text-xs text-zinc-400">дн.</span>
                      </div>
                    )}
                    {steps.length > 1 && (
                      <button onClick={() => removeStep(i)} className="text-zinc-300 hover:text-red-500 transition-colors">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
                <input
                  type="text"
                  placeholder="Тема письма"
                  value={step.subject}
                  onChange={(e) => updateStep(i, 'subject', e.target.value)}
                  className="mb-2 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400"
                />
                <textarea
                  placeholder="Тело письма (поддерживается {{first_name}}, {{company_name}} и другие переменные)"
                  value={step.body}
                  onChange={(e) => updateStep(i, 'body', e.target.value)}
                  rows={4}
                  className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400 resize-y"
                />
              </div>
            ))}
          </div>
        </div>

        {/* Accounts */}
        <div className="rounded-xl border border-zinc-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900 flex items-center gap-2">
            <Mail className="h-4 w-4 text-zinc-400" /> Аккаунты отправки
          </h2>
          {loadingAccounts ? (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-zinc-400" /></div>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-zinc-400 py-4 text-center">Нет доступных аккаунтов</p>
          ) : (
            <>
              <div className="mb-2 flex gap-2">
                <button
                  onClick={() => setSelectedAccounts(accounts.filter(a => a.status === 1).map(a => a.email))}
                  className="text-xs text-zinc-500 hover:text-zinc-800 transition-colors"
                >
                  Выбрать все активные
                </button>
                <button
                  onClick={() => setSelectedAccounts([])}
                  className="text-xs text-zinc-500 hover:text-zinc-800 transition-colors"
                >
                  Снять все
                </button>
              </div>
              <div className="max-h-60 overflow-y-auto space-y-1">
                {accounts.map((acc) => (
                  <label
                    key={acc.email}
                    className={`flex items-center gap-3 rounded-lg px-3 py-2 cursor-pointer transition-colors text-sm ${
                      selectedAccounts.includes(acc.email)
                        ? 'bg-blue-50 border border-blue-100'
                        : 'bg-zinc-50 border border-transparent hover:bg-zinc-100'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedAccounts.includes(acc.email)}
                      onChange={() => toggleAccount(acc.email)}
                      className="sr-only"
                    />
                    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border-2 transition-colors ${
                      selectedAccounts.includes(acc.email)
                        ? 'border-blue-600 bg-blue-600'
                        : 'border-zinc-300 bg-white'
                    }`}>
                      {selectedAccounts.includes(acc.email) && (
                        <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                      )}
                    </span>
                    <span className="truncate">{acc.email}</span>
                    <span className={`ml-auto text-xs ${acc.status === 1 ? 'text-emerald-500' : 'text-zinc-400'}`}>
                      {acc.status === 1 ? 'active' : 'paused'}
                    </span>
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs text-zinc-400">{selectedAccounts.length} выбрано</p>
            </>
          )}
        </div>

        {/* Schedule */}
        <div className="rounded-xl border border-zinc-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900">Расписание</h2>
          <div className="flex flex-wrap gap-4 mb-3">
            <div>
              <label className="mb-1 block text-xs text-zinc-500">С</label>
              <input type="time" value={scheduleFrom} onChange={(e) => setScheduleFrom(e.target.value)} className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-500">До</label>
              <input type="time" value={scheduleTo} onChange={(e) => setScheduleTo(e.target.value)} className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none" />
            </div>
          </div>
          <div className="flex gap-1.5">
            {DAY_NAMES.map((d, i) => (
              <button
                key={i}
                onClick={() => setScheduleDays((prev) => ({ ...prev, [i]: !prev[String(i)] }))}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  scheduleDays[String(i)]
                    ? 'bg-zinc-900 text-white'
                    : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        {/* Settings */}
        <div className="rounded-xl border border-zinc-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900">Параметры</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Дневной лимит</label>
              <input type="number" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Макс. лидов/день</label>
              <input type="number" value={dailyMaxLeads} onChange={(e) => setDailyMaxLeads(e.target.value)} className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Интервал (мин)</label>
              <input type="number" value={emailGap} onChange={(e) => setEmailGap(e.target.value)} className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none" />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-4">
            {([
              { label: 'Стоп на ответ', value: stopOnReply, set: setStopOnReply },
              { label: 'Трекинг открытий', value: openTracking, set: setOpenTracking },
              { label: 'Трекинг ссылок', value: linkTracking, set: setLinkTracking },
              { label: 'Только текст', value: textOnly, set: setTextOnly },
            ] as const).map((opt) => (
              <label key={opt.label} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={opt.value}
                  onChange={(e) => opt.set(e.target.checked)}
                  className="rounded border-zinc-300"
                />
                <span className="text-sm text-zinc-700">{opt.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-3">
          <Link
            href={'/instantly/campaigns' as Route}
            className="rounded-lg border border-zinc-200 px-4 py-2.5 text-sm font-medium text-zinc-600 hover:bg-zinc-50 transition-colors"
          >
            Отмена
          </Link>
          <button
            onClick={handleCreate}
            disabled={creating}
            className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 transition-colors disabled:opacity-50"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Создать кампанию
          </button>
        </div>
      </div>
    </div>
  );
}
