'use client';

import { useState } from 'react';
import { generateReply, skipReply, type GenerateResponse } from './api';
import { SendConfirmDialog } from './SendConfirmDialog';
import type { ReplyListItem } from '@/lib/replyPersonalization/types';

export function ReplyDetailPanel({
  projectId,
  item,
  onHandled,
}: {
  projectId: string;
  item: ReplyListItem;
  onHandled: () => void;
}) {
  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState<GenerateResponse | null>(null);
  const [draftText, setDraftText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [skipping, setSkipping] = useState(false);

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const result = await generateReply(item.id, projectId);
      setDraft(result);
      setDraftText(result.text);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сгенерировать ответ');
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(draftText).catch(() => {});
  };

  const handleSkip = async () => {
    setSkipping(true);
    try {
      await skipReply(item.id, projectId);
      onHandled();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось пропустить письмо');
    } finally {
      setSkipping(false);
    }
  };

  return (
    <div className="p-6">
      <div className="mb-2 text-xs text-zinc-500">
        Переписка · {item.companyName || item.leadEmail}
      </div>

      {item.lastOutboundPreview ? (
        <div className="mb-2 rounded-lg bg-zinc-50 p-3">
          <div className="mb-1 text-[11px] text-zinc-400">Мы отправили</div>
          <div className="text-sm text-zinc-600">{item.lastOutboundPreview}</div>
        </div>
      ) : null}

      <div className="mb-4 rounded-lg border border-zinc-200 p-3">
        <div className="mb-1 text-[11px] text-zinc-400">Ответили</div>
        <div className="text-sm text-zinc-900 whitespace-pre-wrap">{item.replyBody}</div>
      </div>

      {!draft ? (
        <div>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {generating ? 'Генерирую...' : 'Сгенерировать ответ'}
          </button>
          <button
            type="button"
            onClick={handleSkip}
            disabled={skipping}
            className="ml-2 rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            {skipping ? 'Пропускаю...' : 'Пропустить'}
          </button>
        </div>
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs text-zinc-500">Черновик ответа</span>
            <button type="button" onClick={handleGenerate} disabled={generating} className="text-xs text-zinc-500 hover:text-zinc-700">
              {generating ? 'Генерирую...' : 'Сгенерировать заново'}
            </button>
          </div>
          <textarea
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            rows={8}
            className="w-full rounded-lg border border-zinc-300 p-3 text-sm"
          />
          {!draft.contextComplete ? (
            <p className="mt-1 text-xs text-amber-600">Контекст переписки неполный — проверьте текст перед отправкой.</p>
          ) : null}
          {draft.factsUsed ? (
            <p className="mt-2 text-xs text-zinc-400">Факты использованы: {draft.factsUsed}</p>
          ) : null}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={handleSkip}
              disabled={skipping}
              className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              Пропустить
            </button>
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Копировать
            </button>
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
            >
              Отправить ответ
            </button>
          </div>
        </>
      )}

      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}

      {draft ? (
        <SendConfirmDialog
          open={confirmOpen}
          text={draftText}
          onCancel={() => setConfirmOpen(false)}
          onSent={() => {
            setConfirmOpen(false);
            onHandled();
          }}
          qualificationId={item.id}
          draftId={draft.draftId}
        />
      ) : null}
    </div>
  );
}
