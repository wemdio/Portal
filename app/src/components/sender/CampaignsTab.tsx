'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Pause, Play, Plus, Upload } from 'lucide-react';
import {
  createCampaign,
  fetchCampaigns,
  fetchMailboxes,
  patchCampaign,
  uploadRecipients,
  type CampaignDto,
  type MailboxDto,
  type StepInput,
} from './api';

const STATUS_LABELS: Record<CampaignDto['status'], { text: string; className: string }> = {
  draft: { text: 'Черновик', className: 'bg-zinc-100 text-zinc-600' },
  running: { text: 'Идёт', className: 'bg-emerald-100 text-emerald-700' },
  paused: { text: 'Пауза', className: 'bg-amber-100 text-amber-700' },
  done: { text: 'Завершена', className: 'bg-zinc-100 text-zinc-600' },
};

const EMPTY_STEPS: StepInput[] = [
  { delayDays: 0, subject: '', body: '' },
  { delayDays: 3, subject: '', body: '' },
];

export function CampaignsTab() {
  const [campaigns, setCampaigns] = useState<CampaignDto[]>([]);
  const [mailboxes, setMailboxes] = useState<MailboxDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [selectedMailboxes, setSelectedMailboxes] = useState<string[]>([]);
  const [steps, setSteps] = useState<StepInput[]>(EMPTY_STEPS);
  const [hourFrom, setHourFrom] = useState(9);
  const [hourTo, setHourTo] = useState(18);

  const uploadTargetRef = useRef<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [campaignsRes, mailboxesRes] = await Promise.all([fetchCampaigns(), fetchMailboxes()]);
      setCampaigns(campaignsRes.campaigns);
      setMailboxes(mailboxesRes.mailboxes.filter((m) => m.status === 'verified'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить кампании');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    setCreating(true);
    setError(null);
    try {
      await createCampaign({
        name,
        mailboxIds: selectedMailboxes,
        steps: steps.filter((step) => step.body.trim()),
        sendHourFrom: hourFrom,
        sendHourTo: hourTo,
      });
      setName('');
      setSelectedMailboxes([]);
      setSteps(EMPTY_STEPS);
      setNotice('Кампания создана. Загрузите базу получателей и запускайте.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать кампанию');
    } finally {
      setCreating(false);
    }
  };

  const handleUpload = async (file: File) => {
    const campaignId = uploadTargetRef.current;
    if (!campaignId) return;
    setError(null);
    try {
      const res = await uploadRecipients(campaignId, file);
      setNotice(
        `Загружено получателей: ${res.imported}. Пропущено: ${res.skippedInvalid} с плохим адресом, ` +
          `${res.skippedDuplicates} дублей, ${res.skippedSuppressed} из стоп-листа.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить базу');
    }
  };

  const setStep = (index: number, patch: Partial<StepInput>) => {
    setSteps((prev) => prev.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="text-base font-semibold text-zinc-900">Новая кампания</h2>

        <div className="mt-4 space-y-4">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Название кампании"
            className="w-full rounded-lg border border-zinc-300 bg-white px-3.5 py-2.5 text-sm text-zinc-900"
          />

          <div>
            <p className="mb-2 text-sm font-medium text-zinc-900">Ящики для отправки</p>
            {mailboxes.length === 0 ? (
              <p className="text-sm text-zinc-500">Нет проверенных ящиков — сначала подключите их на вкладке «Ящики».</p>
            ) : (
              <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
                {mailboxes.map((mailbox) => {
                  const active = selectedMailboxes.includes(mailbox.id);
                  return (
                    <button
                      key={mailbox.id}
                      type="button"
                      onClick={() =>
                        setSelectedMailboxes((prev) =>
                          active ? prev.filter((id) => id !== mailbox.id) : [...prev, mailbox.id],
                        )
                      }
                      className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                        active
                          ? 'border-blue-500 bg-blue-50 text-blue-700'
                          : 'border-zinc-300 text-zinc-600 hover:bg-zinc-100'
                      }`}
                    >
                      {mailbox.email}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-3">
            {steps.map((step, index) => (
              <div key={index} className="rounded-lg border border-zinc-200 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-zinc-900">
                    {index === 0 ? 'Первое письмо' : `Follow-up ${index}`}
                  </span>
                  {index > 0 ? (
                    <label className="flex items-center gap-2 text-xs text-zinc-500">
                      через
                      <input
                        type="number"
                        min={1}
                        max={30}
                        value={step.delayDays}
                        onChange={(e) => setStep(index, { delayDays: Number(e.target.value) })}
                        className="w-14 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900"
                      />
                      дн.
                    </label>
                  ) : null}
                </div>
                <input
                  value={step.subject}
                  onChange={(e) => setStep(index, { subject: e.target.value })}
                  placeholder={index === 0 ? 'Тема письма' : 'Тема (пусто — ответ в той же переписке)'}
                  className="mb-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
                />
                <textarea
                  value={step.body}
                  onChange={(e) => setStep(index, { body: e.target.value })}
                  rows={4}
                  placeholder="Текст письма. Подстановки: {{first_name}}, {{name}}, {{company}} и любые колонки базы"
                  className="w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
                />
              </div>
            ))}
            {steps.length < 5 ? (
              <button
                type="button"
                onClick={() => setSteps((prev) => [...prev, { delayDays: 3, subject: '', body: '' }])}
                className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-500"
              >
                <Plus className="h-4 w-4" />
                Добавить письмо
              </button>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-600">
            <span>Отправлять с</span>
            <input
              type="number"
              min={0}
              max={23}
              value={hourFrom}
              onChange={(e) => setHourFrom(Number(e.target.value))}
              className="w-16 rounded-md border border-zinc-300 bg-white px-2 py-1 text-zinc-900"
            />
            <span>до</span>
            <input
              type="number"
              min={1}
              max={24}
              value={hourTo}
              onChange={(e) => setHourTo(Number(e.target.value))}
              className="w-16 rounded-md border border-zinc-300 bg-white px-2 py-1 text-zinc-900"
            />
            <span>по будням, Москва</span>
          </div>

          <button
            type="button"
            onClick={() => void submit()}
            disabled={creating}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Создать кампанию
          </button>
        </div>
      </div>

      {notice ? <p className="text-sm text-emerald-600">{notice}</p> : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <div className="rounded-xl border border-zinc-200 bg-white">
        <div className="border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">Кампании</h2>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Загрузка…
          </div>
        ) : campaigns.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-zinc-500">Кампаний пока нет.</p>
        ) : (
          <div className="divide-y divide-zinc-100">
            {campaigns.map((campaign) => {
              const status = STATUS_LABELS[campaign.status];
              const stats = campaign.stats;
              return (
                <div key={campaign.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                  <div className="min-w-48 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-zinc-900">{campaign.name}</span>
                      <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${status.className}`}>
                        {status.text}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">
                      {stats
                        ? `${stats.recipients} получателей · отправлено ${stats.sent} · в очереди ${stats.scheduled} · ответили ${stats.replied}${
                            stats.failed ? ` · ошибок ${stats.failed}` : ''
                          }`
                        : '—'}
                      {' · '}
                      {campaign.send_hour_from}:00–{campaign.send_hour_to}:00
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      uploadTargetRef.current = campaign.id;
                      fileRef.current?.click();
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100"
                  >
                    <Upload className="h-3.5 w-3.5" />
                    База получателей
                  </button>

                  {campaign.status === 'running' ? (
                    <button
                      type="button"
                      onClick={async () => {
                        await patchCampaign(campaign.id, 'pause');
                        await load();
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100"
                    >
                      <Pause className="h-3.5 w-3.5" />
                      Пауза
                    </button>
                  ) : campaign.status !== 'done' ? (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await patchCampaign(campaign.id, 'start');
                          await load();
                        } catch (err) {
                          setError(err instanceof Error ? err.message : 'Не удалось запустить');
                        }
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
                    >
                      <Play className="h-3.5 w-3.5" />
                      Запустить
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".csv,.tsv,.xlsx,.xls"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleUpload(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}
