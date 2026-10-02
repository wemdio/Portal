'use client';

import { useEffect, useRef, useState } from 'react';
import { FileUp, Loader2 } from 'lucide-react';
import { extractTextFromFile } from '@/components/reply-personalization/api';
import { fetchCampaignReplyKb, saveCampaignReplyKb } from './api';
import { SenderModal } from './SenderModal';

type Field = 'brief' | 'tone' | 'example';

const FIELDS: Array<{ key: Field; label: string; hint: string; rows: number }> = [
  { key: 'brief', label: 'Бриф', hint: 'Что продаём, кому, цены, кейсы — всё, чем ИИ может ответить на вопрос лида', rows: 8 },
  { key: 'tone', label: 'Тон и ограничения', hint: 'Как писать и чего не обещать. Пусто — общий тон из «Персонализированных ответов»', rows: 4 },
  { key: 'example', label: 'Пример хорошего письма', hint: 'Ориентир по стилю. Пусто — общие примеры', rows: 6 },
];

/**
 * База знаний кампании для ИИ-ответов лидам. Всё необязательно: без брифа ИИ
 * опирается на нашу цепочку писем в переписке — этого хватает на «интересно,
 * расскажите подробнее», но не на «сколько стоит».
 */
export function CampaignReplyKbModal({ campaignId, onClose }: { campaignId: string; onClose: () => void }) {
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<Field, string>>({ brief: '', tone: '', example: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCampaignReplyKb(campaignId)
      .then((kb) => {
        if (cancelled) return;
        setName(kb.name);
        setValues({ brief: kb.brief, tone: kb.tone, example: kb.example });
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Не удалось загрузить'))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [campaignId]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveCampaignReplyKb(campaignId, values);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  const fromFile = async (file: File) => {
    setExtracting(true);
    setError(null);
    try {
      const text = await extractTextFromFile(file);
      setValues((v) => ({ ...v, brief: v.brief.trim() ? `${v.brief.trim()}\n\n${text}` : text }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось прочитать файл');
    } finally {
      setExtracting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <SenderModal
      title="База знаний для ответов"
      subtitle={name || undefined}
      size="wide"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-3">
          {error ? <span className="text-sm text-red-600">{error}</span> : <span />}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-zinc-300 px-3.5 py-2 text-sm text-zinc-700 hover:bg-zinc-100">
              Отмена
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || loading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Сохранить
            </button>
          </div>
        </div>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Загрузка…
        </div>
      ) : (
        <div className="space-y-4">
          {FIELDS.map((f) => (
            <label key={f.key} className="block">
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-zinc-800">{f.label}</span>
                {f.key === 'brief' ? (
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={extracting}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                  >
                    {extracting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileUp className="h-3.5 w-3.5" />}
                    Из файла
                  </button>
                ) : null}
              </span>
              <span className="mb-1 block text-xs text-zinc-500">{f.hint}</span>
              <textarea
                value={values[f.key]}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                rows={f.rows}
                className="w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
              />
            </label>
          ))}
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,.txt,.md"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void fromFile(file);
            }}
          />
        </div>
      )}
    </SenderModal>
  );
}
