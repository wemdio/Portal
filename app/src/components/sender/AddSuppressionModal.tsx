'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Plus, Upload, X } from 'lucide-react';
import { readXlsxRows } from '@/lib/spreadsheet/parseCSV';
import { addSuppressionList, fetchCampaigns, type CampaignDto } from './api';
import { SenderModal } from './SenderModal';

const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Адреса из текста: построчно, через запятую или вперемешку с чем угодно. */
function emailsIn(text: string): string[] {
  return [...new Set((text.match(EMAIL_IN_TEXT) ?? []).map((e) => e.toLowerCase().replace(/\.+$/, '')))];
}

/**
 * Адреса из файла стоп-листа. Колонку не угадываем: выгрузки бывают из
 * разных систем с разными заголовками, а адрес в любой ячейке — это адрес,
 * который писать нельзя.
 */
async function emailsFromFile(file: File): Promise<string[]> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  const text = ext === 'xlsx' || ext === 'xls'
    ? (await readXlsxRows(await file.arrayBuffer())).map((row) => row.join(' ')).join('\n')
    : await file.text();
  return emailsIn(text);
}

type Target = 'global' | 'campaign';

/**
 * «Добавить в стоп-лист»: общий — адрес не получит писем ни в одной кампании,
 * стоп-лист кампании — только в выбранной. Окно закрывается только крестиком
 * (SenderModal): вставленный список не должен пропасть от промаха мимо окна.
 */
export function AddSuppressionModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  /** Что добавилось — для подписи над списком. */
  onAdded: (notice: string) => void;
}) {
  const [target, setTarget] = useState<Target>('global');
  const [campaigns, setCampaigns] = useState<Pick<CampaignDto, 'id' | 'name'>[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<{ name: string; emails: string[] } | null>(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchCampaigns();
        if (!cancelled) {
          setCampaigns(
            res.campaigns
              .map(({ id, name }) => ({ id, name }))
              .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
          );
        }
      } catch {
        /* список не доехал — выбор кампании будет пустым, общий стоп-лист работает */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const pickFile = async (picked: File) => {
    setReading(true);
    setError(null);
    try {
      const emails = await emailsFromFile(picked);
      if (!emails.length) {
        setError(`В файле «${picked.name}» не нашлось ни одного адреса.`);
        return;
      }
      setFile({ name: picked.name, emails });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось прочитать файл');
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const typed = emailsIn(text);
  const all = [...new Set([...typed, ...(file?.emails ?? [])])];

  const submit = async () => {
    if (!all.length) {
      setError('Впишите хотя бы один адрес или загрузите файл.');
      return;
    }
    if (target === 'campaign' && !campaignId) {
      setError('Выберите кампанию.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await addSuppressionList(all, {
        note: file ? `Файл: ${file.name}` : undefined,
        campaignId: target === 'campaign' ? campaignId : null,
      });
      const where = target === 'campaign'
        ? `в стоп-лист кампании «${campaigns.find((c) => c.id === campaignId)?.name ?? ''}»`
        : 'в общий стоп-лист';
      onAdded(`Добавлено ${where}: ${res.imported}${res.skippedExisting ? ` (уже стояли: ${res.skippedExisting})` : ''}.`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось добавить');
      setSaving(false);
    }
  };

  return (
    <SenderModal
      title="Добавить в стоп-лист"
      onClose={onClose}
      footer={
        <>
          {error ? <span className="mr-auto text-sm text-red-600">{error}</span> : null}
          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving || reading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Добавить{all.length ? ` (${all.length})` : ''}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <div className="inline-flex gap-1 rounded-xl border border-zinc-200 bg-zinc-50 p-1">
            {([
              ['global', 'Глобальный стоп-лист'],
              ['campaign', 'Стоп-лист кампании'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={target === id}
                onClick={() => {
                  setTarget(id);
                  setError(null);
                }}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  target === id ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:bg-zinc-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-zinc-500">
            {target === 'global'
              ? 'Адрес не получит писем ни в одной кампании.'
              : 'Адрес не получит писем только в выбранной кампании.'}
          </p>
        </div>

        {target === 'campaign' ? (
          <select
            value={campaignId}
            onChange={(e) => setCampaignId(e.target.value)}
            aria-label="Кампания"
            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
          >
            <option value="">Выберите кампанию…</option>
            {campaigns.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>{campaign.name}</option>
            ))}
          </select>
        ) : null}

        <div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            placeholder={'lead@firm.ru\nsales@other.com, info@third.ru'}
            aria-label="Адреса"
            className="w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
          />
          <p className="mt-1 text-xs text-zinc-500">
            По одному на строку или через запятую{typed.length ? ` · распознано ${typed.length}` : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={reading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50"
          >
            {reading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Загрузить файл
          </button>
          {file ? (
            <span className="inline-flex items-center gap-1 rounded-lg bg-zinc-100 px-2 py-1 text-xs text-zinc-700">
              {file.name} — {file.emails.length} адресов
              <button
                type="button"
                onClick={() => setFile(null)}
                aria-label="Убрать файл"
                className="rounded p-0.5 text-zinc-400 hover:text-zinc-700"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ) : (
            <span className="text-xs text-zinc-500">CSV, TXT или Excel — берутся все адреса из любых колонок</span>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const picked = e.target.files?.[0];
              if (picked) void pickFile(picked);
            }}
          />
        </div>
      </div>
    </SenderModal>
  );
}
