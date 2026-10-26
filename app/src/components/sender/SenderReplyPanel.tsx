'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Loader2, Send, Sparkles, UserCheck } from 'lucide-react';
import { EDITOR_DEFAULT_PX, EditorResizeHandle, useEditorHeight } from '@/components/ResizableEditor';
import { LeadVerdictBar } from '@/components/senderLeads/LeadVerdictBar';
import {
  fetchReplyDraft,
  fetchThread,
  fetchThreadHandoff,
  generateReplyDraft,
  handoffThread,
  replyToThread,
  saveReplyLanguage,
  type ReplyDraftDto,
  type ReplyLanguage,
  type ThreadHandoffDto,
  type ThreadItemDto,
} from './api';

function formatAt(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Набранный текст переживает переключение переписок и перезагрузку страницы. */
const textKey = (recipientId: string) => `sender-reply-text:${recipientId}`;

function readSaved(recipientId: string): string {
  try {
    return window.localStorage.getItem(textKey(recipientId)) ?? '';
  } catch {
    return '';
  }
}

function writeSaved(recipientId: string, text: string) {
  try {
    if (text.trim()) window.localStorage.setItem(textKey(recipientId), text);
    else window.localStorage.removeItem(textKey(recipientId));
  } catch {
    /* хранилище браузера недоступно — текст просто не переживёт перезагрузку */
  }
}

const sameEmails = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join();

/** Пока ответ в очереди или отправляется, переписку перечитываем: видно, ушёл ли он. */
const PENDING_NOTES = new Set(['в очереди', 'отправляется']);

/**
 * Переписка «Рассылки» с персонализированным ответом — как в инструменте
 * «Персонализированные ответы»: лента писем, метка лида, ИИ пишет ответ на
 * русском или английском по брифу кампании и нашей цепочке, сотрудник правит
 * и отправляет. Письмо уходит с ящика переписки тем же тредом — или, если
 * адресат прислал новый контакт («пишите Екатерине»), ей отдельным письмом
 * либо лиду с ней в копии (плашка «Кому», как в персонализированных ответах).
 */
export function SenderReplyPanel({
  recipientId,
  onSent,
  onVerdictChange,
}: {
  recipientId: string;
  /** Ответ ушёл в очередь — списку пора обновить переписку. */
  onSent?: () => void;
  onVerdictChange?: () => void;
}) {
  const [items, setItems] = useState<ThreadItemDto[]>([]);
  const [header, setHeader] = useState<{ title: string; subtitle: string; mailbox: string | null; email: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [language, setLanguage] = useState<ReplyLanguage>('ru');
  const [hasBrief, setHasBrief] = useState(true);
  const [draft, setDraft] = useState<ReplyDraftDto | null>(null);
  const [text, setText] = useState(() => readSaved(recipientId));
  const [generating, setGenerating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  /** Адреса, на которые адресат перенаправил («пишите Екатерине, почта ...»). */
  const [referredEmails, setReferredEmails] = useState<string[]>([]);
  /** Кому пишем: null — ответ в ту же переписку, иначе новый контакт из ответа. */
  const [recipient, setRecipient] = useState<string | null>(null);
  /** Присланные адресатом адреса в копии ответа ему (при recipient === null). */
  const [ccEmails, setCcEmails] = useState<string[]>([]);
  // Передача лида клиенту: письмо в тот же тред с клиентом в копии.
  const [handoff, setHandoff] = useState<ThreadHandoffDto | null>(null);
  const [handoffMode, setHandoffMode] = useState(false);
  const [ccText, setCcText] = useState('');
  const [handoffDrafting, setHandoffDrafting] = useState(false);
  /** Номер запроса пересказа легенды: отменили или начали другое — ответ не применяется. */
  const handoffDraftReq = useRef(0);
  const cancelHandoffDraft = () => {
    handoffDraftReq.current += 1;
    setHandoffDrafting(false);
  };
  const [notice, setNotice] = useState<string | null>(null);
  /** Лента писем и последнее письмо в ней — чтобы открыть переписку на его начале. */
  const threadRef = useRef<HTMLDivElement>(null);
  // Высота поля ответа — своя ручка над блоком ответа, как в «Персонализированных
  // ответах» (ResizableEditor): родная в углу textarea упиралась в край экрана.
  const rootRef = useRef<HTMLDivElement>(null);
  // Вдвое ниже общей: на всю высоту поле прятало переписку, на которую отвечают.
  const editor = useEditorHeight('sender-reply-editor-height', rootRef, EDITOR_DEFAULT_PX / 4);
  const lastItemRef = useRef<HTMLDivElement>(null);

  const loadThread = useCallback(async () => {
    const res = await fetchThread(recipientId);
    setItems(res.items);
    setHeader({
      title: res.thread.recipient_name || res.thread.recipient_email,
      subtitle: [res.thread.recipient_name ? res.thread.recipient_email : null, res.thread.campaign_name].filter(Boolean).join(' · '),
      mailbox: res.thread.mailbox_email,
      email: res.thread.recipient_email,
    });
    const referred = res.referredEmails ?? [];
    setReferredEmails(referred);
    return referred;
  }, [recipientId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Передача — отдельно и не держит переписку: не доехала — кнопки
        // передачи просто не будет, переписка откроется.
        void fetchThreadHandoff(recipientId)
          .then((res) => { if (!cancelled) setHandoff(res); })
          .catch(() => undefined);
        const [referred, draftRes] = await Promise.all([loadThread(), fetchReplyDraft(recipientId)]);
        if (cancelled) return;
        setLanguage(draftRes.language);
        setHasBrief(draftRes.hasBrief);
        setDraft(draftRes.draft);
        // «Кому» — тот, под кого написан сохранённый черновик, пока адрес ещё в ответе.
        const draftTo = draftRes.draft?.recipientEmail ?? null;
        setRecipient(draftTo && referred.includes(draftTo) ? draftTo : null);
        setCcEmails((draftRes.draft?.ccEmails ?? []).filter((e) => referred.includes(e)));
        // Сохранённый черновик ИИ подставляем, только если руками ничего не набрано.
        if (draftRes.draft && !readSaved(recipientId).trim()) setText(draftRes.draft.text);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Не удалось открыть переписку');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadThread, recipientId]);

  useEffect(() => {
    writeSaved(recipientId, text);
  }, [recipientId, text]);

  // Переписка открывается на начале последнего письма, как в Instantly: к низу
  // длинного письма (часто с цитатой всей прежней переписки) листать незачем.
  useEffect(() => {
    const box = threadRef.current;
    const last = lastItemRef.current;
    if (loading || !box || !last) return;
    box.scrollTop = Math.max(0, last.offsetTop - 16);
  }, [loading, items.length]);

  // У письма передачи к статусу добавлена копия («в очереди · копия: …»).
  const pending = items.some((item) => item.direction === 'out' && item.note && PENDING_NOTES.has(item.note.split(' · ')[0]));
  useEffect(() => {
    if (!pending) return undefined;
    const timer = window.setInterval(() => void loadThread().catch(() => undefined), 5000);
    return () => window.clearInterval(timer);
  }, [pending, loadThread]);

  // Письма ушли или не ушли — состояние передачи обновляем один раз: после
  // неудачной передачи кнопка снова доступна, после удачной — нет.
  const wasPending = useRef(false);
  useEffect(() => {
    if (pending) {
      wasPending.current = true;
      return;
    }
    if (!wasPending.current) return;
    wasPending.current = false;
    void fetchThreadHandoff(recipientId).then(setHandoff, () => undefined);
  }, [pending, recipientId]);

  const hasIncoming = items.some((item) => item.direction === 'in');

  const generate = async () => {
    const manual = text.trim() && text.trim() !== draft?.text.trim();
    if (manual && !window.confirm('В поле ваш текст — заменить его ответом ИИ?')) return;
    cancelHandoffDraft();
    setGenerating(true);
    setError(null);
    try {
      const res = await generateReplyDraft(recipientId, language, { toEmail: recipient, ccEmails: recipient === null ? ccEmails : [] });
      setDraft(res.draft);
      setText(res.draft.text);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сгенерировать ответ');
    } finally {
      setGenerating(false);
    }
  };

  const changeLanguage = (next: ReplyLanguage) => {
    setLanguage(next);
    void saveReplyLanguage(recipientId, next).catch(() => undefined);
  };

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    setError(null);
    try {
      await replyToThread(recipientId, body, draft && body ? draft.id : null, {
        toEmail: recipient,
        ccEmails: recipient === null ? ccEmails : [],
      });
      setConfirming(false);
      setText('');
      setDraft(null);
      setRecipient(null);
      setCcEmails([]);
      await loadThread();
      onSent?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось отправить ответ');
    } finally {
      setSending(false);
    }
  };

  const startHandoff = async () => {
    if (!handoff?.available) return;
    setHandoffMode(true);
    setCcText(handoff.cc.join(', '));
    setNotice(null);
    setError(null);
    setConfirming(true);
    // Легенда проекта подставляется, если руками ещё ничего не набрано; нет
    // легенды — текст в поле остаётся. Пересказ ИИ — только здесь, по кнопке.
    const replaceable = !text.trim() || text.trim() === draft?.text.trim();
    if (!replaceable) return;
    let legend = handoff.draft;
    if (handoff.aiAdapt) {
      const req = ++handoffDraftReq.current;
      setHandoffDrafting(true);
      legend = await fetchThreadHandoff(recipientId, true).then((res) => res.draft, () => handoff.draft);
      if (req !== handoffDraftReq.current) return;
      setHandoffDrafting(false);
    }
    if (legend.trim()) setText(legend);
  };

  const sendHandoff = async () => {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    setError(null);
    try {
      const cc = ccText.split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean);
      const res = await handoffThread(recipientId, body, cc);
      setConfirming(false);
      setHandoffMode(false);
      setText('');
      setDraft(null);
      setNotice(
        res.cabinet === 'after_send'
          ? 'Лид передан: письмо в очереди, клиент увидит лида в кабинете, когда письмо уйдёт.'
          : 'Лид передан: письмо в очереди. У кампании не выбран клиент — в кабинет лид не запишется.',
      );
      // Вторую передачу не даёт база; кнопка покажет, что лид уже передан.
      void fetchThreadHandoff(recipientId).then(setHandoff, () => undefined);
      await loadThread();
      onSent?.();
      onVerdictChange?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось передать лида');
    } finally {
      setSending(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* буфер обмена недоступен */
    }
  };

  // Пока переписка грузится, каркас панели тот же — шапка, лента, поле ответа:
  // раньше вместо них была надпись по центру, и при каждом клике по переписке
  // вся правая часть исчезала и собиралась заново.
  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      {/* Шапка и метка лида в одну строку: каждая прежде занимала свою полосу,
          и на ноутбуке письма читались в щёлку. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-200 px-5 py-2.5">
       <div className="min-w-0 flex-1">
        {loading && !header ? (
          <>
            <div className="h-6 w-48 animate-pulse rounded bg-zinc-100" />
            <div className="mt-1 h-4 w-72 animate-pulse rounded bg-zinc-100" />
          </>
        ) : (
          <>
            <div className="h-6 truncate text-base font-semibold text-zinc-900">{header?.title ?? 'Переписка'}</div>
            <div className="h-4 truncate text-xs text-zinc-500">
              {header?.subtitle}
              {header?.mailbox ? ` · пишем с ${header.mailbox}` : ''}
            </div>
          </>
        )}
       </div>
        {/* Метка лида — подгружается отдельно и не должна сдвигать письма,
            уже прокрученные к последнему. */}
        <div className="shrink-0">
          <LeadVerdictBar recipientId={recipientId} onChange={onVerdictChange} />
        </div>
      </div>

      <div ref={threadRef} className="relative min-h-0 flex-1 overflow-y-auto px-5 pb-4 [scrollbar-gutter:stable]">
        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-zinc-400" aria-label="Загрузка переписки" />
          </div>
        ) : items.length === 0 ? (
          <p className="py-10 text-center text-sm text-zinc-500">Писем в этой переписке пока нет.</p>
        ) : (
          <div className="space-y-3">
            {items.map((item, idx) => {
              const outgoing = item.direction === 'out';
              return (
                <div
                  key={item.id}
                  ref={idx === items.length - 1 ? lastItemRef : undefined}
                  className={`flex ${outgoing ? 'justify-end' : 'justify-start'}`}
                >
                  <div className={`max-w-[85%] rounded-xl border p-3 ${outgoing ? 'border-blue-100 bg-blue-50' : 'border-zinc-200 bg-white'}`}>
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                      <span className="font-medium text-zinc-700">
                        {outgoing ? (item.toEmail ? `Мы → ${item.toEmail}` : 'Мы') : item.fromEmail || 'Адресат'}
                      </span>
                      {item.ccEmails?.length ? <span>копия: {item.ccEmails.join(', ')}</span> : null}
                      <span>{formatAt(item.at)}</span>
                      {item.note ? <span className="rounded-md bg-zinc-100 px-1.5 py-0.5">{item.note}</span> : null}
                    </div>
                    {item.subject ? <p className="text-sm font-medium text-zinc-900">{item.subject}</p> : null}
                    {/* Тело письма — текст как есть: HTML чужого письма в портале не исполняем. */}
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-700">{item.body || '—'}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <EditorResizeHandle
        {...editor}
        className="border-zinc-200 hover:bg-zinc-50 focus-visible:bg-zinc-100"
        gripClassName="bg-zinc-300 group-hover:bg-zinc-400"
      />
      <div className="px-5 pb-3 pt-1">
        {/* Кому: адресат прислал новый адрес — можно написать туда, а не ему.
            Черновик пишется под выбранного получателя, поэтому после смены
            его нужно сгенерировать заново. */}
        {referredEmails.length > 0 ? (
          <div className="mb-2 space-y-1 text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-zinc-500">Кому:</span>
              {[null, ...referredEmails].map((email) => {
                const active = recipient === email;
                return (
                  <button
                    key={email ?? 'lead'}
                    type="button"
                    onClick={() => setRecipient(email)}
                    aria-pressed={active}
                    disabled={generating || sending}
                    className={`rounded-full border px-2 py-0.5 transition ${
                      active ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50'
                    }`}
                  >
                    {email ? `${email} · новый контакт` : `${header?.email ?? 'адресат'} · ответить в переписку`}
                  </button>
                );
              })}
            </div>
            {recipient === null ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-zinc-600">
                <span className="text-zinc-500">В копию:</span>
                {referredEmails.map((email) => (
                  <label key={email} className="inline-flex cursor-pointer items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={ccEmails.includes(email)}
                      disabled={generating || sending}
                      onChange={(e) => setCcEmails((cur) => (e.target.checked ? [...cur, email] : cur.filter((x) => x !== email)))}
                      className="rounded border-zinc-300"
                    />
                    {email}
                  </label>
                ))}
              </div>
            ) : null}
            {draft && draft.recipientEmail !== recipient ? (
              <p className="text-amber-600">Черновик написан для {draft.recipientEmail ?? header?.email} — нажмите «Сгенерировать заново».</p>
            ) : draft && recipient === null && !sameEmails(ccEmails, draft.ccEmails) ? (
              <p className="text-amber-600">Копия изменилась — нажмите «Сгенерировать заново», чтобы текст писался под неё.</p>
            ) : null}
          </div>
        ) : null}
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void generate()}
            disabled={loading || generating || handoffDrafting || !hasIncoming}
            title={hasIncoming ? (hasBrief ? 'В поле появится черновик ИИ, его можно править' : 'У кампании нет брифа — ИИ опирается на нашу цепочку писем (шестерёнка у кампании слева)') : 'Отвечать пока не на что: адресат ещё не ответил'}
            className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
          >
            {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {generating ? 'Генерирую…' : draft ? 'Сгенерировать заново' : 'Сгенерировать ответ'}
          </button>
          <div className="inline-flex rounded-lg border border-zinc-200 bg-zinc-50 p-0.5">
            {(['ru', 'en'] as const).map((lang) => (
              <button
                key={lang}
                type="button"
                onClick={() => changeLanguage(lang)}
                disabled={generating}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                  language === lang ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'
                }`}
              >
                {lang === 'ru' ? 'Рус' : 'Англ'}
              </button>
            ))}
          </div>
          <span className="ml-auto flex gap-2">
            {handoff ? (
              <button
                type="button"
                onClick={() => void startHandoff()}
                disabled={!handoff.available || generating || sending || handoffDrafting}
                title={handoff.available ? `Письмо лиду с копией: ${handoff.cc.join(', ')}` : handoff.reason ?? undefined}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 px-3 py-1.5 text-sm text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
              >
                <UserCheck className="h-4 w-4" />
                Передать клиенту
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void copy()}
              disabled={!text.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
            >
              <Copy className="h-4 w-4" />
              {copied ? 'Скопировано' : 'Копировать'}
            </button>
            <button
              type="button"
              onClick={() => {
                cancelHandoffDraft();
                setHandoffMode(false);
                setConfirming(true);
              }}
              disabled={!text.trim() || generating || sending || handoffDrafting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
              Отправить ответ
            </button>
          </span>
        </div>
        {generating ? <p className="mb-2 text-xs text-zinc-500">ИИ пишет, обычно до минуты</p> : null}

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ height: editor.editorHeight }}
          placeholder="Ответ адресату — сгенерируйте ИИ или напишите сами"
          disabled={loading || generating || sending || handoffDrafting}
          className="w-full resize-none rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 disabled:bg-zinc-50"
        />
        {draft?.factsUsed ? <p className="mt-1 truncate text-xs text-zinc-500" title={draft.factsUsed}>Факты: {draft.factsUsed}</p> : null}

        {confirming && handoffMode ? (
          <div className="mt-2 space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            <p>
              Уйдёт с {handoff?.mailbox ?? 'ящика переписки'} на {handoff?.to} в эту же переписку, клиент — в копии;
              под текстом — цитата ответа лида.
              {handoff && !handoff.clientLinked ? ' У кампании не выбран клиент — в кабинет лид не запишется.' : ''}
              {handoffDrafting ? ' ИИ пересказывает легенду проекта…' : ''}
            </p>
            <label className="flex items-center gap-2">
              <span className="shrink-0 text-emerald-800">Копия:</span>
              <input
                value={ccText}
                onChange={(e) => setCcText(e.target.value)}
                disabled={sending}
                className="w-full rounded-md border border-emerald-300 bg-white px-2 py-1 text-sm text-zinc-900"
              />
            </label>
            <span className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  cancelHandoffDraft();
                  setConfirming(false);
                  setHandoffMode(false);
                }}
                disabled={sending}
                className="rounded-md px-2.5 py-1 text-emerald-700 hover:bg-emerald-100"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => void sendHandoff()}
                disabled={sending || handoffDrafting || !text.trim() || !ccText.trim()}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserCheck className="h-4 w-4" />}
                Передать
              </button>
            </span>
            {error ? <p className="text-red-600">{error}</p> : null}
          </div>
        ) : confirming ? (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
            <span>
              {recipient
                ? `Уйдёт с ${header?.mailbox ?? 'ящика переписки'} новым письмом на ${recipient} — не в эту переписку, в течение минуты.`
                : `Уйдёт с ${header?.mailbox ?? 'ящика переписки'} на ${header?.email}${
                    ccEmails.length ? `, копия: ${ccEmails.join(', ')},` : ''
                  } в эту же переписку — в течение минуты.`}
            </span>
            <span className="flex gap-2">
              <button type="button" onClick={() => setConfirming(false)} disabled={sending} className="rounded-md px-2.5 py-1 text-blue-700 hover:bg-blue-100">
                Отмена
              </button>
              <button
                type="button"
                onClick={() => void send()}
                disabled={sending || handoffDrafting}
                className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1 font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Отправить
              </button>
            </span>
            {error ? <p className="w-full text-red-600">{error}</p> : null}
          </div>
        ) : error ? (
          <p className="mt-2 text-sm text-red-600">{error}</p>
        ) : notice ? (
          <p className="mt-2 text-sm text-emerald-700">{notice}</p>
        ) : null}
      </div>
    </div>
  );
}
