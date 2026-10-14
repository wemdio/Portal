'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Upload, Users } from 'lucide-react';
import {
  googleWorkspaceStatus,
  importMailboxes,
  syncGoogleWorkspace,
  type GoogleSyncAccountDto,
  type ImportMailboxesResult,
} from './api';
import { providerLabel } from './labels';
import { SenderModal } from './SenderModal';

/** Синк воркер делает раз в час; дольше трёх часов тишины — он, скорее всего, стоит. */
const STALE_SYNC_MS = 3 * 60 * 60 * 1000;

/** now — момент, когда статус пришёл с сервера: «N мин назад» считается от него. */
function formatAt(iso: string, now: number): string {
  const minutes = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** Строка аккаунта Workspace: когда читался каталог и не отказал ли Google. */
function GoogleAccountRow({ row, now }: { row: GoogleSyncAccountDto; now: number }) {
  // Ошибка «сейчас» — если после неё не было удачного прогона.
  const failing = row.lastErrorAt !== null
    && (row.lastOkAt === null || row.lastErrorAt >= row.lastOkAt);
  const stale = row.lastRunAt !== null
    && now - new Date(row.lastRunAt).getTime() > STALE_SYNC_MS;

  return (
    <li className="rounded-lg border border-zinc-200 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="font-medium text-zinc-900">{row.account}</span>
        {row.lastRunAt === null ? (
          <span className="text-zinc-500">Синка ещё не было</span>
        ) : (
          <span className={failing ? 'text-red-600' : stale ? 'text-amber-600' : 'text-emerald-600'}>
            {failing ? 'Ошибка' : 'Синк'} {formatAt(row.lastRunAt, now)}
            {row.lastSource === 'manual' ? ' (вручную)' : ''}
          </span>
        )}
      </div>
      {row.mailboxes !== null ? (
        <p className="mt-0.5 text-xs text-zinc-500">
          В каталоге {row.mailboxes}, новых за прогон {row.added ?? 0}
          {stale ? ' · больше 3 ч без синка' : ''}
        </p>
      ) : null}
      {row.lastError && row.lastErrorAt ? (
        <p
          className={`mt-0.5 line-clamp-2 text-xs ${failing ? 'text-red-600' : 'text-zinc-400'}`}
          title={row.lastError}
        >
          {failing ? '' : `Прошлая ошибка ${formatAt(row.lastErrorAt, now)}: `}
          {row.lastError}
        </p>
      ) : null}
    </li>
  );
}

/**
 * «Добавить почты»: загрузка выгрузки провайдера и синк каталога Google.
 * onChanged — список ящиков под окном надо перечитать.
 */
export function AddMailboxesModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ImportMailboxesResult | null>(null);
  // Кнопка Google показывается, только если подключение настроено на сервере.
  const [googleReady, setGoogleReady] = useState(false);
  const [status, setStatus] = useState<{ accounts: GoogleSyncAccountDto[]; at: number }>(
    { accounts: [], at: 0 },
  );
  const [googleBusy, setGoogleBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await googleWorkspaceStatus();
      setGoogleReady(res.configured);
      setStatus({ accounts: res.accounts ?? [], at: Date.now() });
    } catch {
      /* не доехал статус — просто не показываем блок Google */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await googleWorkspaceStatus();
        if (cancelled) return;
        setGoogleReady(res.configured);
        setStatus({ accounts: res.accounts ?? [], at: Date.now() });
      } catch {
        /* не доехал статус — просто не показываем блок Google */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleUpload = async (file: File) => {
    setUploading(true);
    setError(null);
    setNotice(null);
    setResult(null);
    try {
      setResult(await importMailboxes(file));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить файл');
    } finally {
      setUploading(false);
    }
  };

  const runGoogleSync = async () => {
    setGoogleBusy(true);
    setError(null);
    setNotice(null);
    setResult(null);
    try {
      const res = await syncGoogleWorkspace();
      setNotice(
        `Всего ящиков ${res.total}, новых ${res.added}`
        + (res.suspended ? `, заблокированных ${res.suspended}` : '')
        + (res.missing ? `, пропало из каталога ${res.missing}` : '')
        + '. Новые выключены — отметьте галочками те, с которых шлём.',
      );
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось синхронизировать каталог Google');
    } finally {
      setGoogleBusy(false);
      // Итог прогона — в том числе ошибка — уже записан по аккаунтам.
      void loadStatus();
    }
  };

  return (
    <SenderModal
      title="Добавить почты"
      subtitle="Новые ящики приходят выключенными и идут в рассылку после проверки входа."
      onClose={onClose}
    >
      <section>
        <h3 className="text-sm font-semibold text-zinc-900">Файлом</h3>
        <p className="mt-0.5 text-sm text-zinc-500">
          Выгрузка провайдера как есть, CSV или XLSX: колонки и провайдер распознаются сами.
        </p>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="mt-3 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
        >
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {uploading ? 'Загружаю…' : 'Выбрать файл'}
        </button>
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

        {result ? (
          <div className="mt-3 rounded-lg bg-zinc-50 p-3 text-sm">
            <p className="text-zinc-900">Подключено ящиков: {result.imported}</p>
            {result.truncated != null && result.fileRows != null ? (
              <p className="mt-0.5 text-amber-600">
                В файле {result.fileRows} строк, прочитано {result.truncated} — дальше первых 20 000 портал не берёт.
              </p>
            ) : null}
            {/* Провайдера выбрал портал, а не человек — значит, его решение
                должно быть видно сразу, а не всплывать на проверке входа. */}
            {Object.keys(result.detected ?? {}).length ? (
              <p className="mt-0.5 text-zinc-600">
                Распознано:{' '}
                {Object.entries(result.detected)
                  .sort((a, b) => b[1] - a[1])
                  .map(([id, count]) => `${providerLabel(id)} — ${count}`)
                  .join(', ')}
              </p>
            ) : null}
            {result.errors.length ? (
              <ul className="mt-2 space-y-1 text-zinc-600">
                {/* line === null — сломан файл целиком: подпись «Строка N» тут
                    отправила бы искать проблему в данных, хотя она в заголовках. */}
                {result.errors.slice(0, 10).map((row, index) => (
                  <li key={`${row.line ?? 'file'}-${row.email ?? ''}-${index}`}>
                    {row.line === null
                      ? row.message
                      : `Строка ${row.line}${row.email ? ` (${row.email})` : ''}: ${row.message}`}
                  </li>
                ))}
                {result.errors.length > 10 ? <li>…и ещё {result.errors.length - 10}</li> : null}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>

      {googleReady ? (
        <section className="mt-6 border-t border-zinc-200 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-zinc-900">Google Workspace</h3>
              <p className="mt-0.5 text-sm text-zinc-500">Каталог подтягивается сам раз в час.</p>
            </div>
            <button
              type="button"
              onClick={() => void runGoogleSync()}
              disabled={googleBusy}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50"
            >
              {googleBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
              {googleBusy ? 'Синхронизирую…' : 'Синхронизировать сейчас'}
            </button>
          </div>
          {status.accounts.length ? (
            <ul className="mt-3 space-y-2">
              {status.accounts.map((row) => <GoogleAccountRow key={row.account} row={row} now={status.at} />)}
            </ul>
          ) : null}
        </section>
      ) : null}

      {notice ? <p className="mt-4 text-sm text-emerald-600">{notice}</p> : null}
      {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}
    </SenderModal>
  );
}
