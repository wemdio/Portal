'use client';

import { useEffect, useState } from 'react';
import { fetchThread, generateReply, skipReply, type GenerateResponse } from './api';
import { SendConfirmDialog } from './SendConfirmDialog';
import type { ReplyListItem, ThreadMessage } from '@/lib/replyPersonalization/types';

function formatTime(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Правая колонка: полный диалог по письму (наши письма — вправо, адресат —
 * влево, как в мессенджере), под ним генерация черновика и отправка.
 */
export function ReplyDetailPanel({
  projectId,
  item,
  onHandled,
}: {
  projectId: string;
  item: ReplyListItem;
  onHandled: () => void;
}) {
  const [thread, setThread] = useState<ThreadMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(true);
  const [threadIncomplete, setThreadIncomplete] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState<GenerateResponse | null>(null);
  const [draftText, setDraftText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [skipping, setSkipping] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setThreadLoading(true);
    setThreadIncomplete(false);
    fetchThread(item.id, projectId)
      .then((res) => {
        if (cancelled) return;
        setThread(res.messages);
        setThreadIncomplete(!res.contextComplete);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Не удалось загрузить переписку');
      })
      .finally(() => {
        if (!cancelled) setThreadLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item.id, projectId]);

  const handleGenerate = async () => {
    // Свой набранный текст молча не затираем: генерация кладёт черновик в то
    // же поле, где менеджер мог уже написать ответ.
    const typedByHand = draftText.trim() && draftText !== draft?.text;
    if (typedByHand && !window.confirm('Заменить написанный текст черновиком от ИИ?')) return;
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
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Шапка диалога */}
      <div className="border-b border-gray-100 px-4 py-2.5">
        <div className="text-sm font-semibold text-gray-900">{item.companyName || item.leadEmail}</div>
        <div className="text-xs text-gray-500">
          {item.leadEmail}
          {item.campaignName ? ` · ${item.campaignName}` : ''}
        </div>
      </div>

      {/* Переписка пузырями */}
      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        {threadLoading ? (
          <div className="text-sm text-gray-500">Загружаем переписку...</div>
        ) : thread.length === 0 ? (
          <div className="text-sm text-gray-500">Переписка не найдена.</div>
        ) : (
          thread.map((m, idx) => (
            <div key={idx} className={`flex ${m.fromUs ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[80%] rounded-2xl border px-3.5 py-2 text-sm ${
                  m.fromUs ? 'border-blue-200 bg-blue-50' : 'border-gray-200 bg-gray-50'
                }`}
              >
                <div className="mb-0.5 text-[11px] text-gray-500">
                  {m.fromUs ? 'Мы' : 'Адресат'}
                  {m.timestamp ? ` · ${formatTime(m.timestamp)}` : ''}
                </div>
                <div className="whitespace-pre-wrap break-words text-gray-900">{m.text}</div>
              </div>
            </div>
          ))
        )}
        {threadIncomplete && !threadLoading ? (
          <p className="text-center text-[11px] text-amber-600">
            Полный тред получить не удалось — показаны сохранённые отрывки.
          </p>
        ) : null}
      </div>

      {/* Ответ: сверху — помощь ИИ (сгенерировать / пропустить), под ней
          поле ответа, которое видно всегда. Раньше написать ответ можно было
          только поверх сгенерированного черновика — на короткое «Спасибо,
          перезвоним» менеджер ждал генерацию. Черновик ИИ ложится в это же
          поле, дальше его можно править как свой текст. */}
      <div className="border-t border-gray-100 p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating}
            className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {generating ? 'Генерирую...' : draft ? 'Сгенерировать заново' : 'Сгенерировать ответ'}
          </button>
          <button
            type="button"
            onClick={handleSkip}
            disabled={skipping}
            className="rounded-lg border border-gray-300 px-3.5 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {skipping ? 'Пропускаю...' : 'Пропустить'}
          </button>
          {draft ? <span className="ml-auto text-xs text-gray-500">В поле — черновик ИИ, его можно править</span> : null}
        </div>

        <textarea
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          rows={6}
          placeholder="Напишите ответ сами или нажмите «Сгенерировать ответ»"
          className="w-full rounded-lg border border-gray-300 p-3 text-sm"
        />
        {draft && !draft.contextComplete ? (
          <p className="mt-1 text-xs text-amber-600">
            Контекст переписки неполный — проверьте текст перед отправкой.
          </p>
        ) : null}
        {draft?.factsUsed ? (
          <p className="mt-2 text-xs text-gray-400">Факты использованы: {draft.factsUsed}</p>
        ) : null}

        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={handleCopy}
            disabled={!draftText.trim()}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Копировать
          </button>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={!draftText.trim()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            Отправить ответ
          </button>
        </div>

        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}

        <SendConfirmDialog
          open={confirmOpen}
          text={draftText}
          onCancel={() => setConfirmOpen(false)}
          onSent={() => {
            setConfirmOpen(false);
            onHandled();
          }}
          qualificationId={item.id}
          projectId={projectId}
          draftId={draft?.draftId ?? null}
        />
      </div>
    </div>
  );
}
