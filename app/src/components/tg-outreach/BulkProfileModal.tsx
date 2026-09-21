'use client';

import { useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Clock, ImagePlus, Loader2, Play, X } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import type { OutreachAccount } from '@/lib/tgOutreach/types';
import { AccountAvatar } from './AccountAvatar';

/**
 * Массовое автозаполнение профилей: выделили аккаунты — заполнили все разом.
 *
 * Поштучно это делалось через карточку аккаунта: открыть, нажать
 * «Автозаполнить», сохранить, закрыть — и так двадцать раз на партию. Здесь тот
 * же путь, но один на всю выборку и с видимым ходом работы.
 *
 * Перебор идёт в браузере, по одному аккаунту за раз, а не одним запросом на
 * сервер. Причин две: каждый аккаунт поднимает своё соединение с Telegram через
 * мобильный прокси — на двадцати аккаунтах это минуты, и такой запрос просто
 * не доживёт до ответа; и оператор должен видеть, на ком остановились, а не
 * ждать одного «готово» в конце.
 */

const API_BASE = '/api/tools/tg-outreach';
const MAX_AVATAR_BYTES = 1024 * 1024;

type RowState = 'idle' | 'running' | 'done' | 'queued' | 'error';

interface Row {
  account: OutreachAccount;
  state: RowState;
  /** Что сейчас происходит или чем кончилось. */
  detail: string;
  /** Итоговое имя и ник — то, что реально встало в Telegram. */
  result: string;
  avatar: File | null;
  avatarUrl: string | null;
}

function accountLabel(account: OutreachAccount): string {
  const name = [account.first_name, account.last_name].filter(Boolean).join(' ').trim();
  return name || account.session_name;
}

interface AutofillResponse {
  first_name?: string;
  last_name?: string;
  username?: string | null;
  bio?: string;
  queued_check?: boolean;
  note?: string;
  error?: string;
}

interface ApplyResponse {
  queued?: boolean;
  message?: string;
  first_name?: string;
  last_name?: string;
  tg_username?: string;
  avatar_url?: string;
  avatar_error?: string;
  error?: string;
}

export function BulkProfileModal({
  accounts,
  onClose,
  onApplied,
}: {
  accounts: OutreachAccount[];
  onClose: () => void;
  /**
   * Готовый аккаунт обновляется в списке сразу, строкой. Перечитывать весь
   * список нельзя: он уедет под ногами у оператора, который в это время
   * листает, да и заполненные аккаунты видно и так — по этому же окну.
   */
  onApplied: (id: string, patch: Partial<OutreachAccount>) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    accounts.map((account) => ({
      account,
      state: 'idle' as RowState,
      detail: '',
      result: '',
      avatar: null,
      avatarUrl: null,
    })),
  );
  const [running, setRunning] = useState(false);
  // Останов — через ref: обработчик кнопки должен дотянуться до цикла, который
  // уже идёт, а обновление состояния до него не доедет.
  const stopRef = useRef(false);
  const bulkFileRef = useRef<HTMLInputElement>(null);
  const rowFileRef = useRef<HTMLInputElement>(null);
  const rowTargetRef = useRef<number | null>(null);
  const [touched, setTouched] = useState(false);

  const stats = useMemo(() => {
    const done = rows.filter((r) => r.state === 'done').length;
    const queued = rows.filter((r) => r.state === 'queued').length;
    const failed = rows.filter((r) => r.state === 'error').length;
    return { done, queued, failed, total: rows.length };
  }, [rows]);

  const patchRow = (index: number, patch: Partial<Row>) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const attachAvatar = (index: number, file: File | null) => {
    if (file && file.size > MAX_AVATAR_BYTES) {
      patchRow(index, { state: 'error', detail: `Картинка больше 1 МБ (${Math.round(file.size / 1024)} КБ)` });
      return;
    }
    patchRow(index, {
      avatar: file,
      avatarUrl: file ? URL.createObjectURL(file) : null,
      ...(file ? { state: 'idle' as RowState, detail: '' } : {}),
    });
  };

  /** Несколько файлов сразу — раскладываются по аккаунтам в порядке списка. */
  const attachMany = (files: FileList) => {
    [...files].slice(0, rows.length).forEach((file, i) => attachAvatar(i, file));
  };

  const runOne = async (index: number): Promise<void> => {
    const row = rows[index];
    const id = row.account.id;

    patchRow(index, { state: 'running', detail: 'Подбираю имя и свободный ник…', result: '' });
    let proposal: AutofillResponse;
    try {
      const res = await authFetch(`${API_BASE}/accounts/${id}/profile/autofill`, { method: 'POST' });
      proposal = (await res.json()) as AutofillResponse;
      if (!res.ok) throw new Error(proposal.error || `Ошибка ${res.status}`);
    } catch (e) {
      patchRow(index, { state: 'error', detail: e instanceof Error ? e.message : 'Не удалось подобрать профиль' });
      return;
    }

    if (!proposal.username) {
      patchRow(index, {
        state: 'error',
        detail: 'Свободный ник не нашёлся — попробуйте запустить ещё раз, наберутся другие варианты.',
      });
      return;
    }

    patchRow(index, { detail: 'Записываю профиль в Telegram…' });
    const form = new FormData();
    form.append('first_name', proposal.first_name ?? '');
    form.append('last_name', proposal.last_name ?? '');
    form.append('bio', proposal.bio ?? '');
    form.append('username', proposal.username);
    if (row.avatar) form.append('avatar', row.avatar);

    try {
      const res = await authFetch(`${API_BASE}/accounts/${id}/profile`, { method: 'PUT', body: form });
      const data = (await res.json()) as ApplyResponse;
      if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);

      if (data.queued) {
        patchRow(index, {
          state: 'queued',
          detail: data.message || 'Кампания работает — профиль применится в круге рассылки.',
          result: `${proposal.first_name} ${proposal.last_name} · @${proposal.username}`,
        });
        return;
      }

      const name = [data.first_name, data.last_name].filter(Boolean).join(' ');
      onApplied(id, {
        first_name: data.first_name,
        last_name: data.last_name,
        tg_username: data.tg_username,
        ...(data.avatar_url ? { avatar_url: data.avatar_url } : {}),
      });
      patchRow(index, {
        state: 'done',
        detail: data.avatar_error ? `Профиль записан, аватарка — нет: ${data.avatar_error}` : 'Готово',
        result: `${name}${data.tg_username ? ` · @${data.tg_username}` : ''}`,
      });
    } catch (e) {
      patchRow(index, { state: 'error', detail: e instanceof Error ? e.message : 'Не удалось записать профиль' });
    }
  };

  const run = async () => {
    stopRef.current = false;
    setRunning(true);
    setTouched(true);
    for (let i = 0; i < rows.length; i += 1) {
      if (stopRef.current) {
        patchRow(i, { state: 'idle', detail: 'Остановлено' });
        break;
      }
      // Аккаунты идут по одному: каждый поднимает своё соединение с Telegram
      // через мобильный прокси, и параллельный залп по одному пулу прокси —
      // верный способ получить ограничения на всю партию разом.
      await runOne(i);
    }
    setRunning(false);
  };

  const close = () => {
    stopRef.current = true;
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm sm:items-center"
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label="Автозаполнение профилей"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="my-auto flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Автозаполнение профилей</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              Выбрано аккаунтов: {rows.length}. Каждому подберётся имя, фамилия, свободный ник и описание.
              Аватарки — по желанию, файлами.
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Закрыть"
            className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 bg-gray-50 px-5 py-2.5">
          <button
            type="button"
            onClick={() => bulkFileRef.current?.click()}
            disabled={running}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs text-gray-700 transition hover:bg-gray-100 disabled:opacity-50"
          >
            <ImagePlus className="h-3.5 w-3.5" />
            Аватарки файлами
          </button>
          <span className="text-[11px] text-gray-400">
            Можно выбрать сразу несколько — разложатся по аккаунтам сверху вниз. До 1 МБ каждая.
          </span>
          {stats.done || stats.queued || stats.failed ? (
            <span className="ml-auto text-xs text-gray-500">
              Готово {stats.done} из {stats.total}
              {stats.queued ? ` · в очереди ${stats.queued}` : ''}
              {stats.failed ? ` · с ошибкой ${stats.failed}` : ''}
            </span>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 divide-y divide-gray-100 overflow-y-auto">
          {rows.map((row, index) => (
            <div key={row.account.id} className="flex items-center gap-3 px-5 py-2.5">
              <button
                type="button"
                disabled={running}
                onClick={() => {
                  rowTargetRef.current = index;
                  rowFileRef.current?.click();
                }}
                title="Выбрать аватарку для этого аккаунта"
                className="relative shrink-0 rounded-full transition hover:opacity-80 disabled:opacity-60"
              >
                {row.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={row.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
                ) : (
                  <AccountAvatar account={row.account} />
                )}
                <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-white p-0.5 text-gray-400">
                  <ImagePlus className="h-2.5 w-2.5" />
                </span>
              </button>

              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-gray-800">
                  {accountLabel(row.account)}
                </div>
                <div className="truncate text-[11px] text-gray-400">
                  {row.result || row.detail || row.account.session_name}
                </div>
              </div>

              <div className="shrink-0">
                {row.state === 'running' ? (
                  <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
                ) : row.state === 'done' ? (
                  <Check className="h-4 w-4 text-emerald-500" />
                ) : row.state === 'queued' ? (
                  <Clock className="h-4 w-4 text-amber-500" />
                ) : row.state === 'error' ? (
                  <AlertCircle className="h-4 w-4 text-rose-500" />
                ) : (
                  <span className="text-[11px] text-gray-300">ждёт</span>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-200 bg-gray-50 px-5 py-3">
          <span className="mr-auto text-[11px] text-gray-500">
            {running
              ? 'Идёт по одному аккаунту: каждый подключается к Telegram через свой прокси.'
              : 'На работающей кампании профиль встанет в очередь, а аватарка — нет: её меняют на остановленной.'}
          </span>
          {running ? (
            <button
              type="button"
              onClick={() => { stopRef.current = true; }}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 transition hover:bg-gray-100"
            >
              Остановить
            </button>
          ) : (
            <button
              type="button"
              onClick={close}
              className="rounded-lg px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-100"
            >
              Закрыть
            </button>
          )}
          <button
            type="button"
            onClick={() => void run()}
            disabled={running || rows.length === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {touched && !running ? 'Запустить ещё раз' : 'Запуск'}
          </button>
        </div>
      </div>

      <input
        ref={bulkFileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) attachMany(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={rowFileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const index = rowTargetRef.current;
          const file = e.target.files?.[0] ?? null;
          if (index != null && file) attachAvatar(index, file);
          e.target.value = '';
        }}
      />
    </div>
  );
}
