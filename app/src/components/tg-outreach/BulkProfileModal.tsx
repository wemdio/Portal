'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Clock, ImagePlus, Loader2, Save, Sparkles, X } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import type { OutreachAccount } from '@/lib/tgOutreach/types';
import { AccountAvatar } from './AccountAvatar';

/**
 * Массовое заполнение профилей: выделили аккаунты — настроили все разом.
 *
 * Работа разбита на два шага, и это главное в этом окне. «Подобрать имена»
 * ничего не меняет в Telegram — оно только предлагает имя, фамилию, свободный
 * ник и описание. Пишет в Telegram отдельная кнопка «Сохранить изменения».
 *
 * Разделение не ради осторожности, а потому что шаги независимы. Аватарки
 * выбираются руками, файлами, и почти всегда уже после того, как имена
 * подобраны. Пока запуск писал в Telegram сразу, у партии с заполненными
 * профилями не было способа поменять одни только аватарки: любое нажатие
 * перезаписывало имена. Теперь не нажали «Подобрать» — имена не тронуты, уедут
 * только картинки.
 *
 * Перебор идёт в браузере, а не одним запросом на сервер: каждый аккаунт
 * поднимает своё соединение с Telegram через мобильный прокси, и на двадцати
 * аккаунтах такой запрос просто не доживёт до ответа.
 *
 * Аккаунты идут пачками по LANE_COUNT штук одновременно. Строго по одному было
 * честно, но мучительно: двадцать аккаунтов по десять секунд — это три минуты
 * ожидания у экрана. Залпом на всю выборку тоже нельзя: пул мобильных прокси
 * общий, и два десятка одновременных подключений он встретит ограничениями на
 * всю партию. Несколько дорожек — середина, которая и ускоряет, и не выглядит
 * со стороны Telegram как всплеск.
 */

const API_BASE = '/api/tools/tg-outreach';
const MAX_AVATAR_BYTES = 1024 * 1024;
/** Сколько аккаунтов обрабатываем одновременно. */
const LANE_COUNT = 3;

type RowState = 'idle' | 'busy' | 'done' | 'queued' | 'error';

interface Proposal {
  firstName: string;
  lastName: string;
  username: string;
  bio: string;
}

interface Row {
  account: OutreachAccount;
  /** Что подобрали, но ещё не сохранили. null — имя оставляем как есть. */
  proposal: Proposal | null;
  avatar: File | null;
  avatarUrl: string | null;
  state: RowState;
  /** Что сейчас происходит или чем кончилось. */
  detail: string;
}

function currentName(account: OutreachAccount): string {
  return [account.first_name, account.last_name].filter(Boolean).join(' ').trim() || account.session_name;
}

interface AutofillResponse {
  first_name?: string;
  last_name?: string;
  username?: string | null;
  bio?: string;
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
   * список нельзя: он уедет под ногами у оператора, который в это время листает.
   */
  onApplied: (id: string, patch: Partial<OutreachAccount>) => void;
}) {
  const initial = useMemo<Row[]>(
    () => accounts.map((account) => ({
      account,
      proposal: null,
      avatar: null,
      avatarUrl: null,
      state: 'idle' as RowState,
      detail: '',
    })),
    [accounts],
  );
  const [rows, setRows] = useState<Row[]>(initial);
  /**
   * Зеркало строк для циклов.
   *
   * Цикл живёт дольше одного рендера, а читать ему нужно свежее: аватарку могли
   * прицепить между подбором и сохранением. Состояние, попавшее в замыкание
   * цикла, застыло бы на момент нажатия кнопки.
   */
  const rowsRef = useRef<Row[]>(initial);

  const [busy, setBusy] = useState<null | 'pick' | 'save'>(null);
  const stopRef = useRef(false);
  const bulkFileRef = useRef<HTMLInputElement>(null);
  const rowFileRef = useRef<HTMLInputElement>(null);
  const rowTargetRef = useRef<number | null>(null);

  const update = useCallback((index: number, patch: Partial<Row>) => {
    rowsRef.current = rowsRef.current.map((row, i) => (i === index ? { ...row, ...patch } : row));
    setRows(rowsRef.current);
  }, []);

  const attachAvatar = (index: number, file: File) => {
    if (file.size > MAX_AVATAR_BYTES) {
      update(index, { state: 'error', detail: `Картинка больше 1 МБ (${Math.round(file.size / 1024)} КБ)` });
      return;
    }
    update(index, { avatar: file, avatarUrl: URL.createObjectURL(file), state: 'idle', detail: '' });
  };

  /** Несколько файлов сразу — раскладываются по аккаунтам в порядке списка. */
  const attachMany = (files: FileList) => {
    [...files].slice(0, rowsRef.current.length).forEach((file, i) => attachAvatar(i, file));
  };

  /** Шаг 1: подобрать имя и свободный ник. В Telegram ничего не пишет. */
  const pickOne = async (index: number) => {
    const { account } = rowsRef.current[index];
    update(index, { state: 'busy', detail: 'Подбираю имя и свободный ник…' });
    try {
      const res = await authFetch(`${API_BASE}/accounts/${account.id}/profile/autofill`, { method: 'POST' });
      const data = (await res.json()) as AutofillResponse;
      if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
      if (!data.username) {
        update(index, {
          state: 'error',
          detail: 'Свободный ник не нашёлся — нажмите «Подобрать имена» ещё раз, наберутся другие варианты.',
        });
        return;
      }
      update(index, {
        state: 'idle',
        detail: '',
        proposal: {
          firstName: data.first_name ?? '',
          lastName: data.last_name ?? '',
          username: data.username,
          bio: data.bio ?? '',
        },
      });
    } catch (e) {
      update(index, { state: 'error', detail: e instanceof Error ? e.message : 'Не удалось подобрать профиль' });
    }
  };

  /**
   * Шаг 2: записать в Telegram.
   *
   * Строка без подобранного профиля, но с аватаркой уезжает с ТЕКУЩИМИ именем и
   * описанием аккаунта, а поле ника не отправляется вовсе: у ручки отсутствие
   * поля значит «не трогать», а пустая строка — «снять ник», и это разные
   * намерения. Так меняется только картинка.
   */
  const saveOne = async (index: number) => {
    const row = rowsRef.current[index];
    const { account, proposal, avatar } = row;
    if (!proposal && !avatar) return;

    update(index, { state: 'busy', detail: 'Записываю в Telegram…' });
    const form = new FormData();
    form.append('first_name', proposal ? proposal.firstName : (account.first_name ?? ''));
    form.append('last_name', proposal ? proposal.lastName : (account.last_name ?? ''));
    form.append('bio', proposal ? proposal.bio : (account.bio ?? ''));
    if (proposal) form.append('username', proposal.username);
    if (avatar) form.append('avatar', avatar);

    try {
      const res = await authFetch(`${API_BASE}/accounts/${account.id}/profile`, { method: 'PUT', body: form });
      const data = (await res.json()) as ApplyResponse;
      if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);

      if (data.queued) {
        update(index, {
          state: 'queued',
          detail: data.message || 'Кампания работает — профиль применится в круге рассылки.',
        });
        return;
      }

      onApplied(account.id, {
        first_name: data.first_name,
        last_name: data.last_name,
        tg_username: data.tg_username,
        ...(data.avatar_url ? { avatar_url: data.avatar_url } : {}),
      });
      update(index, {
        state: 'done',
        detail: data.avatar_error ? `Профиль записан, аватарка — нет: ${data.avatar_error}` : 'Сохранено',
        // Подобранное уже применено: держать его дальше значит предлагать
        // сохранить второй раз то же самое. Файл отпускаем, а картинку в строке
        // оставляем — иначе аватарка исчезала ровно в момент «Сохранено», и это
        // читалось как «не применилось».
        proposal: null,
        avatar: null,
        avatarUrl: data.avatar_error ? null : row.avatarUrl,
        // Имя в строке тоже обновляем на то, что реально встало в Telegram.
        account: {
          ...account,
          first_name: data.first_name ?? account.first_name,
          last_name: data.last_name ?? account.last_name,
          tg_username: data.tg_username ?? account.tg_username,
          ...(data.avatar_url ? { avatar_url: data.avatar_url } : {}),
        },
      });
    } catch (e) {
      update(index, { state: 'error', detail: e instanceof Error ? e.message : 'Не удалось записать профиль' });
    }
  };

  const runAll = async (kind: 'pick' | 'save') => {
    stopRef.current = false;
    setBusy(kind);

    // Общая очередь и несколько дорожек: как только дорожка освободилась, она
    // берёт следующий аккаунт. Делить список на равные куски заранее нельзя —
    // аккаунты отвечают за разное время, и дорожка с быстрыми простаивала бы,
    // пока соседняя дожёвывает свои.
    let next = 0;
    const lane = async () => {
      for (;;) {
        if (stopRef.current) return;
        const index = next;
        next += 1;
        if (index >= rowsRef.current.length) return;
        if (kind === 'pick') await pickOne(index);
        else await saveOne(index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(LANE_COUNT, rowsRef.current.length) }, lane));

    setBusy(null);
  };

  const close = () => {
    stopRef.current = true;
    onClose();
  };

  const pending = rows.filter((r) => r.proposal || r.avatar).length;
  const saved = rows.filter((r) => r.state === 'done').length;
  const queued = rows.filter((r) => r.state === 'queued').length;
  const failed = rows.filter((r) => r.state === 'error').length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm sm:items-center"
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label="Профили аккаунтов"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="my-auto flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Профили аккаунтов</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              Выбрано аккаунтов: {rows.length}. «Подобрать имена» только предлагает — в Telegram ничего
              не уйдёт, пока не нажмёте «Сохранить изменения».
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
            disabled={busy != null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs text-gray-700 transition hover:bg-gray-100 disabled:opacity-50"
          >
            <ImagePlus className="h-3.5 w-3.5" />
            Аватарки файлами
          </button>
          <span className="text-[11px] text-gray-400">
            Можно выбрать сразу несколько — разложатся по аккаунтам сверху вниз. До 1 МБ каждая.
          </span>
          {saved || queued || failed ? (
            <span className="ml-auto text-xs text-gray-500">
              Сохранено {saved}
              {queued ? ` · в очереди ${queued}` : ''}
              {failed ? ` · с ошибкой ${failed}` : ''}
            </span>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 divide-y divide-gray-100 overflow-y-auto">
          {rows.map((row, index) => (
            <div key={row.account.id} className="flex items-center gap-3 px-5 py-2.5">
              <button
                type="button"
                disabled={busy != null}
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
                <div className="truncate text-xs font-medium text-gray-800">{currentName(row.account)}</div>
                <div className="truncate text-[11px] text-gray-400">
                  {row.detail || row.account.session_name}
                </div>
              </div>

              {/* Что уедет по кнопке «Сохранить». Пусто — имя оставляем как
                  есть, и тогда уедет только аватарка. */}
              {row.proposal ? (
                <div className="flex min-w-0 shrink items-center gap-1.5">
                  <span className="truncate text-[11px] text-indigo-700">
                    → {row.proposal.firstName} {row.proposal.lastName} · @{row.proposal.username}
                  </span>
                  <button
                    type="button"
                    disabled={busy != null}
                    onClick={() => update(index, { proposal: null })}
                    title="Не менять имя этому аккаунту — оставить как есть"
                    className="rounded p-0.5 text-gray-300 transition hover:text-rose-500 disabled:opacity-50"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : row.avatar ? (
                <span className="shrink-0 text-[11px] text-indigo-700">→ только аватарка</span>
              ) : null}

              <div className="w-5 shrink-0 text-right">
                {row.state === 'busy' ? (
                  <Loader2 className="ml-auto h-4 w-4 animate-spin text-indigo-500" />
                ) : row.state === 'done' ? (
                  <Check className="ml-auto h-4 w-4 text-emerald-500" />
                ) : row.state === 'queued' ? (
                  <Clock className="ml-auto h-4 w-4 text-amber-500" />
                ) : row.state === 'error' ? (
                  <AlertCircle className="ml-auto h-4 w-4 text-rose-500" />
                ) : null}
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-200 bg-gray-50 px-5 py-3">
          <span className="mr-auto text-[11px] text-gray-500">
            {busy
              ? `Идём по ${LANE_COUNT} аккаунта разом: каждый подключается к Telegram через свой прокси.`
              : pending
                ? `К сохранению: ${pending}`
                : 'На работающей кампании профиль встанет в очередь, а аватарка — нет: её меняют на остановленной.'}
          </span>
          {busy ? (
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
            onClick={() => void runAll('pick')}
            disabled={busy != null || rows.length === 0}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-100 disabled:opacity-50"
          >
            {busy === 'pick' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Подобрать имена
          </button>
          <button
            type="button"
            onClick={() => void runAll('save')}
            disabled={busy != null || pending === 0}
            title={pending === 0 ? 'Нечего сохранять: подберите имена или добавьте аватарки' : undefined}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Сохранить изменения
          </button>
        </div>

        {/*
          Поля выбора файла живут ВНУТРИ окна, а не рядом с ним.

          Подложка закрывается по клику мимо окна, а `input.click()` порождает
          настоящее событие клика, которое всплывает как обычное. Пока поля
          лежали снаружи, этот клик доходил до подложки и закрывал модалку ровно
          в тот момент, когда открывался диалог выбора файла.
        */}
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
    </div>
  );
}
