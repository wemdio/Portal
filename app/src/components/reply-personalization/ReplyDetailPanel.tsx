'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { fetchOpenDraft, fetchThread, generateReply, skipReply, type GenerateResponse } from './api';
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

/*
 * Черновик переживает переход в другое письмо. Каждая генерация стоит денег,
 * а раньше при возврате к письму поле было пустым, и менеджер генерировал
 * заново. Теперь:
 * - черновик ИИ берём из базы (он сохраняется при генерации);
 * - текст в поле — свой или правленый черновик — держим в браузере;
 * - если генерация ещё шла, когда ушли из письма, при возврате ждём её
 *   результат, а не запускаем новую.
 * localStorage может быть недоступен (приватный режим) — тогда просто
 * работаем как раньше.
 */
const TEXT_KEY = (id: string) => `rp-reply-text:${id}`;
const GEN_KEY = (id: string) => `rp-reply-generating:${id}`;
/** Дольше генерация не идёт — старую отметку «генерирую» считаем брошенной. */
const GEN_MAX_MS = 5 * 60_000;
const GEN_POLL_MS = 4_000;

function readStore(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // без хранилища просто не запоминаем
  }
}

/*
 * Высота поля ответа. Родная ручка textarea стоит в правом нижнем углу, а поле
 * прижато к низу экрана: тянуть её можно только вверх, и она упирается в край.
 * Поэтому ручка своя — полоса над блоком ответа: тянешь вверх, поле растёт за
 * счёт переписки. Выбранную высоту помним в браузере, двойной щелчок по ручке
 * возвращает исходную. Исходная — с запасом под черновик ИИ целиком: шести
 * строк не хватало даже на короткий ответ.
 */
const EDITOR_HEIGHT_KEY = 'rp-reply-editor-height';
const EDITOR_DEFAULT_PX = 320;
const EDITOR_MIN_PX = 120;
/** Столько оставляем шапке, кусочку переписки и кнопкам под полем. */
const EDITOR_RESERVED_PX = 260;
const EDITOR_KEY_STEP_PX = 24;

function editorMaxHeight(panelPx: number): number {
  return Math.max(EDITOR_MIN_PX, panelPx - EDITOR_RESERVED_PX);
}

function clampEditorHeight(px: number, panelPx: number): number {
  return Math.round(Math.min(Math.max(px, EDITOR_MIN_PX), editorMaxHeight(panelPx)));
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
  onHandled: (id: string, status: 'sent' | 'skipped') => void;
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
  /** Адреса, на которые адресат перенаправил («пишите Екатерине, почта ...»). */
  const [referredEmails, setReferredEmails] = useState<string[]>([]);
  /** Кому пишем: null — ответ в ту же переписку, иначе новый контакт из ответа. */
  const [recipient, setRecipient] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [editorHeight, setEditorHeight] = useState(EDITOR_DEFAULT_PX);
  /** Предел для ручки — зависит от высоты панели, пересчитываем с окном. */
  const [editorMax, setEditorMax] = useState(EDITOR_DEFAULT_PX);
  /** Текущая высота без ожидания рендера: её пишем в хранилище по отпусканию ручки. */
  const heightRef = useRef(EDITOR_DEFAULT_PX);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const panelHeight = () => rootRef.current?.clientHeight ?? window.innerHeight;
  const applyHeight = (px: number) => {
    heightRef.current = px;
    setEditorHeight(px);
  };

  // Сохранённую высоту читаем после монтирования: на сервере хранилища нет, и
  // разметка до гидрации должна совпасть. Окно сжали — поле ужимаем следом,
  // иначе оно выдавит кнопки «Отправить» за край.
  useEffect(() => {
    const panel = () => rootRef.current?.clientHeight ?? window.innerHeight;
    const saved = Number(readStore(EDITOR_HEIGHT_KEY));
    const initial = clampEditorHeight(saved > 0 ? saved : EDITOR_DEFAULT_PX, panel());
    heightRef.current = initial;
    setEditorHeight(initial);
    setEditorMax(editorMaxHeight(panel()));
    const onResize = () => {
      const next = clampEditorHeight(heightRef.current, panel());
      heightRef.current = next;
      setEditorHeight(next);
      setEditorMax(editorMaxHeight(panel()));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const startResize = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startHeight: heightRef.current };
  };

  const moveResize = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Ручка над полем: тянем вверх — поле выше.
    applyHeight(clampEditorHeight(drag.startHeight + (drag.startY - e.clientY), panelHeight()));
  };

  const endResize = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    writeStore(EDITOR_HEIGHT_KEY, String(heightRef.current));
  };

  const resizeByKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const step = e.key === 'ArrowUp' ? EDITOR_KEY_STEP_PX : -EDITOR_KEY_STEP_PX;
    const next = clampEditorHeight(heightRef.current + step, panelHeight());
    applyHeight(next);
    writeStore(EDITOR_HEIGHT_KEY, String(next));
  };

  const resetHeight = () => {
    applyHeight(clampEditorHeight(EDITOR_DEFAULT_PX, panelHeight()));
    writeStore(EDITOR_HEIGHT_KEY, null);
  };

  useEffect(() => {
    let cancelled = false;
    setThreadLoading(true);
    setThreadIncomplete(false);
    fetchThread(item.id, projectId)
      .then((res) => {
        if (cancelled) return;
        setThread(res.messages);
        setThreadIncomplete(!res.contextComplete);
        setReferredEmails(res.referredEmails ?? []);
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

  // Вернуть в поле то, что было: свой текст из браузера, иначе сохранённый
  // черновик ИИ; если генерация ещё идёт — дождаться её.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const savedText = readStore(TEXT_KEY(item.id));
    const genStartedAt = Number(readStore(GEN_KEY(item.id)) ?? 0);
    const genInFlight = genStartedAt > 0 && Date.now() - genStartedAt < GEN_MAX_MS;
    if (savedText) setDraftText(savedText);
    if (genInFlight) setGenerating(true);

    const apply = (found: (GenerateResponse & { createdAt: string }) | null) => {
      if (!found) return false;
      setDraft(found);
      setRecipient(found.recipientEmail ?? null);
      // Свой текст главнее: он мог быть правкой этого же черновика.
      if (!readStore(TEXT_KEY(item.id))) setDraftText(found.text);
      return true;
    };

    const poll = async () => {
      try {
        const { draft: found } = await fetchOpenDraft(item.id);
        if (cancelled) return;
        const fresh = found && Date.parse(found.createdAt) >= genStartedAt - 60_000;
        const stillRunning = readStore(GEN_KEY(item.id)) !== null && Date.now() - genStartedAt < GEN_MAX_MS;
        if (genInFlight && !fresh && stillRunning) {
          timer = window.setTimeout(poll, GEN_POLL_MS);
          return;
        }
        apply(found);
        setGenerating(false);
      } catch {
        if (!cancelled) setGenerating(false);
      }
    };
    void poll();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [item.id]);

  const updateText = (value: string) => {
    setDraftText(value);
    writeStore(TEXT_KEY(item.id), value.trim() ? value : null);
  };

  const forgetLocal = () => {
    writeStore(TEXT_KEY(item.id), null);
    writeStore(GEN_KEY(item.id), null);
  };

  const handleGenerate = async () => {
    // Свой набранный текст молча не затираем: генерация кладёт черновик в то
    // же поле, где менеджер мог уже написать ответ.
    const typedByHand = draftText.trim() && draftText !== draft?.text;
    if (typedByHand && !window.confirm('Заменить написанный текст черновиком от ИИ?')) return;
    const qualificationId = item.id;
    setGenerating(true);
    setError(null);
    writeStore(GEN_KEY(qualificationId), String(Date.now()));
    try {
      const result = await generateReply(qualificationId, projectId, recipient);
      // Новый черновик заменяет набранный текст — и в браузере тоже.
      writeStore(TEXT_KEY(qualificationId), null);
      setDraft(result);
      setDraftText(result.text);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сгенерировать ответ');
    } finally {
      writeStore(GEN_KEY(qualificationId), null);
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
      forgetLocal();
      onHandled(item.id, 'skipped');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось пропустить письмо');
    } finally {
      setSkipping(false);
    }
  };

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      {/* Шапка диалога */}
      <div className="border-b border-gray-100 px-4 py-2.5">
        <div className="text-sm font-semibold text-gray-900">{item.companyName || item.leadEmail}</div>
        <div className="text-xs text-gray-500">
          {item.leadEmail}
          {item.source === 'others'
            ? item.eaccount
              ? ` · пришло на ${item.eaccount}`
              : ''
            : item.campaignName
              ? ` · ${item.campaignName}`
              : ''}
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

      {/* Ручка высоты поля ответа — граница между перепиской и ответом:
          тянешь вверх, поле растёт. Почему своя, а не родная у textarea, —
          см. EDITOR_HEIGHT_KEY. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Высота поля ответа"
        aria-valuenow={editorHeight}
        aria-valuemin={EDITOR_MIN_PX}
        aria-valuemax={editorMax}
        tabIndex={0}
        title="Потяните вверх, чтобы увеличить поле ответа. Двойной щелчок — исходная высота"
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onDoubleClick={resetHeight}
        onKeyDown={resizeByKey}
        className="group flex h-4 shrink-0 cursor-row-resize touch-none select-none items-center justify-center border-t border-gray-100 hover:bg-gray-50 focus:outline-none focus-visible:bg-gray-100"
      >
        <div className="h-1 w-10 rounded-full bg-gray-300 transition group-hover:bg-gray-400" />
      </div>

      {/* Кому: адресат прислал новый адрес — можно написать туда, а не ему.
          Черновик пишется под выбранного получателя, поэтому после смены
          его нужно сгенерировать заново. */}
      {referredEmails.length > 0 ? (
        <div className="px-4 pt-1">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-gray-500">Кому:</span>
            {[null, ...referredEmails].map((email) => {
              const isActive = recipient === email;
              return (
                <button
                  key={email ?? 'lead'}
                  type="button"
                  onClick={() => setRecipient(email)}
                  aria-pressed={isActive}
                  className={`rounded-full border px-2 py-0.5 transition ${
                    isActive
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {email ? `${email} · новый контакт` : `${item.leadEmail} · ответить в переписку`}
                </button>
              );
            })}
          </div>
          {draft && (draft.recipientEmail ?? null) !== recipient ? (
            <p className="mt-1 text-xs text-amber-600">
              Черновик написан для {draft.recipientEmail ?? item.leadEmail} — нажмите «Сгенерировать заново».
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Ответ: сверху — помощь ИИ (сгенерировать / пропустить), под ней
          поле ответа, которое видно всегда. Раньше написать ответ можно было
          только поверх сгенерированного черновика — на короткое «Спасибо,
          перезвоним» менеджер ждал генерацию. Черновик ИИ ложится в это же
          поле, дальше его можно править как свой текст. */}
      <div className={referredEmails.length > 0 ? 'border-t border-gray-100 p-4' : 'px-4 pb-4 pt-1'}>
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
          onChange={(e) => updateText(e.target.value)}
          style={{ height: editorHeight }}
          placeholder="Напишите ответ сами или нажмите «Сгенерировать ответ»"
          className="w-full resize-none rounded-lg border border-gray-300 p-3 text-sm"
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
            forgetLocal();
            onHandled(item.id, 'sent');
          }}
          qualificationId={item.id}
          projectId={projectId}
          draftId={draft?.draftId ?? null}
          toEmail={recipient ?? item.leadEmail}
          newContact={recipient !== null}
          separateLetter={Boolean(item.outOfCampaign) && recipient === null}
        />
      </div>
    </div>
  );
}
