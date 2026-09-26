'use client';

/**
 * Блок «Рассылка» на экране запуска русского и английского аутричей
 * (спека 2026-09-26-outreach-to-sender-design.md §5): залить готовые компании
 * запуска в рассылку папки «Автоаутрич RU/EN» и запустить её, не уходя в
 * «Рассылку». Правила заливки и запуска — на сервере
 * (lib/outreachSender/upload.ts), здесь только кнопки и понятные тексты.
 * Адреса у RU и EN разные (…/[jobId]/sender), остальное общее — компонент
 * один и получает адрес запуска пропсом.
 */

import { useCallback, useEffect, useId, useState } from 'react';
import { ExternalLink, Loader2, Play, Upload } from 'lucide-react';
import { authFetch, authFetchJson } from '@/lib/authFetch';
// Только типы: import type стирается при сборке, серверный модуль в браузер не попадает.
import type { JobSenderCampaign, JobSenderStatus, UploadJobResult } from '@/lib/outreachSender/upload';

/** Экран «Рассылки»: папки и рассылки — во вкладке «Кампании». */
const SENDER_PAGE = '/tools/sender';

const CAMPAIGN_STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: 'черновик', tone: 'bg-gray-100 text-gray-600' },
  running: { label: 'идёт', tone: 'bg-emerald-50 text-emerald-700' },
  paused: { label: 'на паузе', tone: 'bg-amber-50 text-amber-800' },
  done: { label: 'завершена', tone: 'bg-gray-100 text-gray-600' },
};

interface Notice {
  tone: 'ok' | 'warn' | 'error';
  text: string;
}

const NOTICE_TONE: Record<Notice['tone'], string> = {
  ok: 'bg-emerald-50 text-emerald-800',
  warn: 'bg-amber-50 text-amber-800',
  error: 'bg-red-50 text-red-700',
};

const SELECT =
  'max-w-xs rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400';

function companies(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} компания`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} компании`;
  return `${n} компаний`;
}

function campaignStatus(status: string): { label: string; tone: string } {
  return CAMPAIGN_STATUS[status] ?? { label: status, tone: 'bg-gray-100 text-gray-600' };
}

/** Итог заливки словами: куда и сколько залито, что пропущено и почему. */
function uploadText(r: UploadJobResult): string {
  const skipped = [
    r.skippedSuppressed ? `стоп-лист ${r.skippedSuppressed}` : null,
    r.skippedExisting ? `уже были ${r.skippedExisting}` : null,
    r.skippedDuplicates ? `одна почта у нескольких компаний ${r.skippedDuplicates}` : null,
    r.skippedEmptyLetter ? `без письма ${r.skippedEmptyLetter}` : null,
    r.skippedInvalid ? `плохой адрес ${r.skippedInvalid}` : null,
  ].filter(Boolean);
  const head = `В рассылку «${r.campaignName}» ${r.mode === 'append' ? 'добавлено' : 'залито'}: ${companies(r.inserted)}`;
  const tail = skipped.length ? `; пропущено: ${skipped.join(', ')}.` : '.';
  // Черновик сам не отправляет — без этой фразы легко решить, что письма уже ушли.
  const next = r.mode === 'new' ? ' Это черновик: письма пойдут после кнопки «Запустить рассылку».' : '';
  return head + tail + next;
}

/** Ошибка роута: текст сервера как есть; без JSON — прокси или обрыв. */
function errorNotice(status: number, body: unknown, action: string): Notice {
  const message = (body as { error?: unknown } | null)?.error;
  const text =
    typeof message === 'string' && message
      ? message
      : status === 401
        ? 'Сессия истекла — обновите страницу и войдите снова.'
        : `Не удалось ${action} (ошибка ${status}).`;
  // 409 и 422 — не сбой, а «сейчас нельзя»: всё уже залито, рассылка идёт, в папке нет ящиков.
  return { tone: status === 409 || status === 422 ? 'warn' : 'error', text };
}

/**
 * Куда доливать по умолчанию: выбранная раньше рассылка, если она ещё
 * принимает компании, иначе черновик или пауза этого же запуска, иначе
 * самая новая рассылка папки.
 */
function pickTarget(prev: string, data: JobSenderStatus): string {
  const targets = data.appendTargets ?? [];
  if (targets.some((t) => t.id === prev)) return prev;
  const own = (data.campaigns ?? []).find((c) => c.canStart && targets.some((t) => t.id === c.id));
  return own?.id ?? targets[0]?.id ?? '';
}

interface Props {
  /** Адрес запуска в API: /api/tools/polza-ru-outreach/{id} или /api/parsers/polza-outreach/{id}. */
  jobUrl: string;
  /** Запуск идёт: заливать нельзя, пока не готовы все компании. */
  running: boolean;
  /**
   * Готовых компаний запуска: стало иначе (после «Переписать цепочку») —
   * блок перечитывает, что можно долить.
   */
  readyCount?: number | null;
  /** После заливки или запуска: перечитать запуск и таблицу. */
  onChanged?: () => void;
}

export function SenderBlock({ jobUrl, running, readyCount, onChanged }: Props) {
  const radioName = useId();
  const [status, setStatus] = useState<JobSenderStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<'new' | 'append'>('new');
  const [targetId, setTargetId] = useState('');
  /** upload — идёт заливка; иначе id рассылки, которую запускают. */
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await authFetchJson<JobSenderStatus>(`${jobUrl}/sender`);
      setStatus(data);
      setLoadError(null);
      setTargetId((prev) => pickTarget(prev, data));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Не удалось загрузить');
    }
  }, [jobUrl]);

  // Пока запуск идёт, статус не опрашиваем: заливать до конца нельзя, а сервер
  // на каждый показ читает все готовые строки. Перечитываем, когда запуск
  // закончился и когда стало иначе число готовых (после «Переписать цепочку»).
  const refreshKey = running ? -1 : (readyCount ?? -1);
  useEffect(() => {
    // Загрузка при открытии запуска — запрос во внешнюю систему.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, running, refreshKey]);

  // Доливать некуда (рассылку папки запустили или завершили) — остаётся только новая.
  const effectiveMode = status?.appendTargets?.length ? mode : 'new';

  const upload = async () => {
    setBusy('upload');
    setNotice(null);
    try {
      const res = await authFetch(`${jobUrl}/sender`, {
        method: 'POST',
        body: JSON.stringify(effectiveMode === 'append' ? { mode: 'append', campaignId: targetId } : { mode: 'new' }),
      });
      const body: unknown = await res.json().catch(() => null);
      setNotice(res.ok && body ? { tone: 'ok', text: uploadText(body as UploadJobResult) } : errorNotice(res.status, body, 'залить компании'));
    } catch {
      setNotice({ tone: 'error', text: 'Связь с сервером прервалась — обновите экран и проверьте, залились ли компании.' });
    }
    setBusy(null);
    await load();
    onChanged?.();
  };

  const start = async (campaign: JobSenderCampaign) => {
    if (!window.confirm(`«${campaign.name}»: письма начнут уходить по расписанию папки. Запустить?`)) return;
    setBusy(campaign.id);
    setNotice(null);
    try {
      const res = await authFetch(`${jobUrl}/sender/start`, { method: 'POST', body: JSON.stringify({ campaignId: campaign.id }) });
      const body: unknown = await res.json().catch(() => null);
      if (res.ok) {
        const added = Number((body as { mailboxesAdded?: unknown } | null)?.mailboxesAdded ?? 0) || 0;
        setNotice({
          tone: 'ok',
          text: `Рассылка «${campaign.name}» запущена — письма пойдут по расписанию папки.${added ? ` Ящиков подключено из папки: ${added}.` : ''}`,
        });
      } else {
        setNotice(errorNotice(res.status, body, 'запустить рассылку'));
      }
    } catch {
      setNotice({ tone: 'error', text: 'Связь с сервером прервалась — обновите экран и проверьте, запустилась ли рассылка.' });
    }
    setBusy(null);
    await load();
    onChanged?.();
  };

  const header = (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <div className="text-sm font-semibold text-gray-900">Рассылка</div>
      {status ? (
        <div className="text-xs text-gray-500">
          Папка «{status.folder.name}» · ящиков в папке: {status.folder.mailboxes}, рабочих: {status.folder.workingMailboxes}
        </div>
      ) : null}
    </div>
  );

  if (!status) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        {header}
        {loadError ? (
          <div className="mt-2 text-sm text-red-700">Не удалось загрузить: {loadError}</div>
        ) : (
          <div className="mt-2 flex items-center gap-2 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Загружаем…
          </div>
        )}
      </div>
    );
  }

  const { folder, campaigns, pending, uploaded, uploadedDeleted, smtpUnavailable } = status;
  const targets = status.appendTargets ?? [];
  const blocked = [
    pending.suppressed ? `в стоп-листе — ${pending.suppressed}` : null,
    pending.invalid ? `некорректный адрес — ${pending.invalid}` : null,
  ].filter(Boolean);
  const hasUploads = uploaded > 0 || uploadedDeleted > 0 || campaigns.length > 0;
  // Заливку предлагаем, только если она пройдёт: запуск закончился и почты
  // прошли SMTP-проверку. Без неё сервер откажет всегда, конец запуска не поможет.
  const offerUpload = !running && !smtpUnavailable;
  const senderLink = (label: string) => (
    <a
      href={SENDER_PAGE}
      target="_blank"
      rel="noreferrer"
      title={`Вкладка «Кампании», папка «${folder.name}»`}
      className="inline-flex items-center gap-1 font-medium text-violet-700 hover:underline"
    >
      {label}
      <ExternalLink className="h-3 w-3" />
    </a>
  );

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      {header}
      <p className="mt-0.5 text-xs text-gray-500">
        Готовые компании заливаются в рассылку вместе со своими письмами. Письма начинают уходить только после кнопки «Запустить рассылку».
      </p>

      {/* Без рабочих ящиков рассылка не запустится; залить можно и так — черновик подождёт. */}
      {folder.workingMailboxes === 0 ? (
        <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {folder.mailboxes === 0
            ? `Выберите ящики в настройках папки “${folder.name}” в Рассылке — без них рассылка не запустится.`
            : `В папке “${folder.name}” нет рабочих ящиков: письма уходят только с проверенных ящиков с галочкой. Выберите такие в настройках папки в Рассылке.`}{' '}
          {senderLink('Открыть Рассылку')}
        </div>
      ) : null}

      <div className="mt-3 space-y-2 text-sm text-gray-700">
        {uploaded > 0 ? <div>Уже в Рассылке: {companies(uploaded)} из этого запуска.</div> : null}
        {/* Рассылку удалили, а письма из неё уходили: отметки остались, чтобы
            компаниям не написали второй раз (api/tools/sender/campaigns/[id]). */}
        {uploadedDeleted > 0 ? (
          <div className="text-gray-500">
            Были в рассылке, которую потом удалили: {companies(uploadedDeleted)}. Повторно их не зальём, чтобы им не написали второй раз.
          </div>
        ) : null}
        {/* Без SMTP-проверки адрес «рабочий», если у домена есть почтовый
            сервер: несуществующие ящики вернули бы отбойники по нашим ящикам. */}
        {smtpUnavailable ? (
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">
            Залить в Рассылку нельзя: почты этого запуска проверены только по MX — SMTP-проверка была недоступна. Часть писем
            вернулась бы, а ящики потеряли бы репутацию.
          </div>
        ) : null}
        {offerUpload && pending.uploadable > 0 ? (
          <div>
            {hasUploads ? 'Новых готовых к заливке' : 'Готово к заливке'}: {companies(pending.uploadable)}.
          </div>
        ) : null}
        {offerUpload && blocked.length ? <div className="text-gray-500">Не зальются: {blocked.join(', ')}.</div> : null}
        {!running && pending.total === 0 && uploaded === 0 && uploadedDeleted === 0 ? (
          <div className="text-gray-500">Готовых компаний для заливки нет.</div>
        ) : null}
        {!running && pending.total === 0 && (uploaded > 0 || uploadedDeleted > 0) ? (
          <div className="text-gray-500">
            {uploadedDeleted > 0 ? 'Все готовые компании запуска уже заливались в Рассылку.' : 'Все готовые компании запуска уже в Рассылке.'}
          </div>
        ) : null}

        {smtpUnavailable ? null : running ? (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled
              className="inline-flex items-center rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              <Upload className="mr-1.5 h-4 w-4" /> Залить в Рассылку
            </button>
            <span className="text-xs text-gray-500">Заливать можно после окончания запуска</span>
          </div>
        ) : pending.uploadable > 0 ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="inline-flex items-center gap-1.5">
              <input type="radio" name={radioName} checked={effectiveMode === 'new'} onChange={() => setMode('new')} />
              Новая рассылка
            </label>
            <label
              className={`inline-flex items-center gap-1.5 ${targets.length ? '' : 'text-gray-400'}`}
              title={targets.length ? undefined : `В папке «${folder.name}» нет черновиков и рассылок на паузе`}
            >
              <input
                type="radio"
                name={radioName}
                disabled={!targets.length}
                checked={effectiveMode === 'append'}
                onChange={() => setMode('append')}
              />
              Добавить в существующую
            </label>
            {effectiveMode === 'append' ? (
              <select className={SELECT} value={targetId} onChange={(e) => setTargetId(e.target.value)} aria-label="Рассылка, в которую добавить компании">
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} — {campaignStatus(t.status).label}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              type="button"
              disabled={busy !== null || (effectiveMode === 'append' && !targetId)}
              onClick={() => void upload()}
              className="inline-flex items-center rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {busy === 'upload' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Upload className="mr-1.5 h-4 w-4" />}
              {hasUploads ? `Долить новые (${pending.uploadable})` : 'Залить в Рассылку'}
            </button>
          </div>
        ) : null}
      </div>

      {notice ? <div className={`mt-3 rounded-lg px-3 py-2 text-sm ${NOTICE_TONE[notice.tone]}`}>{notice.text}</div> : null}

      {campaigns.length ? (
        <div className="mt-4">
          <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-500">Рассылки этого запуска</div>
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
            {campaigns.map((c) => {
              const st = campaignStatus(c.status);
              const editable = c.status === 'draft' || c.status === 'paused';
              return (
                <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-gray-900">{c.name}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${st.tone}`}>{st.label}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-gray-500">
                      получателей {c.recipients} · отправлено {c.sent} · ответили {c.replied}
                      {/* В рассылку доливали и другие запуски — показываем, сколько здесь наших. */}
                      {c.fromThisJob < c.recipients ? ` · из этого запуска ${c.fromThisJob}` : ''}
                    </div>
                  </div>
                  <span className="text-xs">{senderLink('Открыть в Рассылке')}</span>
                  {/* Кнопка — только у рассылки, созданной этим запуском: ту, куда он лишь
                      доливал, запускают там, где её создали. */}
                  {c.canStart ? (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void start(c)}
                      className="inline-flex items-center rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {busy === c.id ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
                      Запустить рассылку
                    </button>
                  ) : editable ? (
                    <span className="text-xs text-gray-400">запускается в «Рассылке»</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
