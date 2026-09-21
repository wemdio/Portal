'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, Search, Trash2, Upload, Users } from 'lucide-react';
import {
  bulkMailboxes,
  deleteMailbox,
  fetchMailboxes,
  fetchMailboxTags,
  googleWorkspaceStatus,
  syncGoogleWorkspace,
  importMailboxes,
  patchMailbox,
  type BulkMailboxAction,
  type ImportMailboxesResult,
  type MailboxDto,
  type MailboxTagDto,
} from './api';
import { GOOGLE_STATE_LABELS, MAILBOX_STATUS_LABELS, providerLabel } from './labels';
import { TagAssignMenu, TagChip, TagFilterMenu } from './MailboxTags';

const PAGE_SIZE = 30;
const EMPTY_SELECTION: ReadonlySet<string> = new Set();
/** Пауза между буквой и запросом: иначе поиск стоит запроса на символ. */
const SEARCH_DEBOUNCE_MS = 300;

export function MailboxesTab() {
  const [mailboxes, setMailboxes] = useState<MailboxDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  // Отдельно от loading: первая загрузка рисует заглушку вместо таблицы, а
  // переход на другую страницу — кружок поверх уже показанных строк. Подменять
  // на заглушку и её тоже значит заставлять глаз заново искать, где он был.
  const [paging, setPaging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ImportMailboxesResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Выбор хранится вместе со страницей, которой он принадлежит, а не
  // сбрасывается эффектом на смену страницы: эффект ради setState — лишний
  // каскад рендеров, и его же запрещает правило react-hooks/set-state-in-effect.
  // Соседняя страница — другие строки, и «выбрано 30» там означало бы не то,
  // что видно на экране.
  const [selection, setSelection] = useState<{ page: number; ids: Set<string> }>(
    { page: 1, ids: new Set() },
  );
  const [bulkBusy, setBulkBusy] = useState(false);
  // Подключение к Workspace настраивается на сервере; кнопка показывается,
  // только если настроено, — иначе она обещала бы то, чего портал не умеет.
  const [googleReady, setGoogleReady] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // search — то, что набрано в поле; appliedSearch — то, что уже ушло в запрос.
  // Разделены, чтобы каждая буква не стоила похода на сервер, а список не
  // перерисовывался в процессе набора.
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const searchTimer = useRef<number | null>(null);
  const [tags, setTags] = useState<MailboxTagDto[]>([]);
  const [untagged, setUntagged] = useState(0);
  const [tagFilter, setTagFilter] = useState<ReadonlySet<string>>(EMPTY_SELECTION);
  const [noTagFilter, setNoTagFilter] = useState(false);
  // Ключ строкой: Set в списке зависимостей useCallback сравнивается по ссылке,
  // и список перезагружался бы на каждый рендер.
  const tagFilterKey = [...tagFilter].sort().join(',');

  const load = useCallback(async (targetPage: number) => {
    try {
      const { mailboxes: rows, total: count } = await fetchMailboxes({
        page: targetPage,
        search: appliedSearch || undefined,
        tagIds: tagFilterKey ? tagFilterKey.split(',') : undefined,
        noTag: noTagFilter || undefined,
      });
      setMailboxes(rows);
      setTotal(count);
      // Строку удалили и страница стала пустой — откатываемся к предыдущей.
      if (rows.length === 0 && count > 0 && targetPage > 1) {
        setPage(Math.max(1, Math.ceil(count / PAGE_SIZE)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить ящики');
    } finally {
      setLoading(false);
    }
  }, [appliedSearch, tagFilterKey, noTagFilter]);

  const loadTags = useCallback(async () => {
    try {
      const res = await fetchMailboxTags();
      setTags(res.tags);
      setUntagged(res.untagged);
    } catch {
      /* теги не доехали — фильтр просто останется пустым */
    }
  }, []);

  useEffect(() => {
    void loadTags();
  }, [loadTags]);

  // Ушли с экрана недонабрав — отложенный запрос отменяем.
  useEffect(() => () => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
  }, []);

  useEffect(() => {
    // Кружок только на переходах, которые затеял человек: опрос статусов раз в
    // 15 секунд зовёт load мимо этого эффекта и мигать ничем не должен.
    setPaging(true);
    void load(page).finally(() => setPaging(false));
  }, [load, page]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await googleWorkspaceStatus();
        if (!cancelled) setGoogleReady(res.configured);
      } catch {
        /* не доехал статус — просто не показываем кнопку */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Ящики после загрузки проверяются воркером — подтягиваем статусы, пока
    // есть хоть один в очереди на проверку. Сортировка по email стабильна,
    // поэтому опрос больше дёргает строки местами.
    const timer = window.setInterval(() => void load(page), 15_000);
    return () => window.clearInterval(timer);
  }, [load, page]);

  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleUpload = async (file: File) => {
    setUploading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await importMailboxes(file));
      await load(page);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить файл');
    } finally {
      setUploading(false);
    }
  };

  const runGoogleSync = async () => {
    setGoogleBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await syncGoogleWorkspace();
      setNotice(
        `Каталог Google: всего ящиков ${res.total}, новых ${res.added}`
        + (res.suspended ? `, заблокированных ${res.suspended}` : '')
        + (res.missing ? `, пропало из каталога ${res.missing}` : '')
        + '. Новые ящики выключены — отметьте галочками те, с которых шлём.'
        + (res.failed.length
          ? ` Не прочитался каталог: ${res.failed.map((f) => `${f.account} (${f.error})`).join('; ')}.`
          : ''),
      );
      await load(page);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось синхронизировать каталог Google');
    } finally {
      setGoogleBusy(false);
    }
  };

  const act = async (id: string, body: Record<string, unknown>) => {
    await patchMailbox(id, body);
    await load(page);
  };

  const remove = async (mailbox: MailboxDto) => {
    if (!window.confirm(`Убрать ящик ${mailbox.email} из инструмента?`)) return;
    await deleteMailbox(mailbox.id);
    await load(page);
  };

  // Автообновление статусов раз в 15 секунд выбор не трогает: id те же.
  const selected = selection.page === page ? selection.ids : EMPTY_SELECTION;
  const setSelected = (ids: Set<string>) => setSelection({ page, ids });

  const allOnPageSelected = mailboxes.length > 0 && mailboxes.every((m) => selected.has(m.id));
  const someOnPageSelected = mailboxes.some((m) => selected.has(m.id));

  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const toggleAllOnPage = () => {
    setSelected(allOnPageSelected ? new Set() : new Set(mailboxes.map((m) => m.id)));
  };

  /**
   * Смена фильтра — это другой набор строк: возвращаемся на первую страницу и
   * снимаем галочки. «Выбрано 12» после смены фильтра относилось бы к ящикам,
   * которых на экране больше нет.
   */
  const resetToFirstPage = () => {
    setPage(1);
    setSelection({ page: 1, ids: new Set() });
  };

  const onSearchChange = (value: string) => {
    setSearch(value);
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    // Пауза отсчитывается в обработчике ввода, а не в эффекте: так опрос
    // статусов раз в 15 секунд не может затереть набранное.
    searchTimer.current = window.setTimeout(() => {
      setAppliedSearch(value.trim());
      resetToFirstPage();
    }, SEARCH_DEBOUNCE_MS);
  };

  const toggleTagFilter = (id: string) => {
    const next = new Set(tagFilter);
    if (next.has(id)) next.delete(id); else next.add(id);
    setTagFilter(next);
    resetToFirstPage();
  };

  const toggleNoTagFilter = () => {
    setNoTagFilter((v) => !v);
    resetToFirstPage();
  };

  const resetTagFilter = () => {
    setTagFilter(EMPTY_SELECTION);
    setNoTagFilter(false);
    resetToFirstPage();
  };

  /** «Под тег» на выборку: у ящика может быть только один тег, поэтому замена. */
  const assignTag = async (tagId: string | null) => {
    const ids = [...selected];
    if (!ids.length) return;
    const withTag = mailboxes.filter((m) => ids.includes(m.id) && m.tag).length;
    if (tagId && withTag
      && !window.confirm(
        `У ${withTag} из ${ids.length} ящиков тег уже стоит — он заменится на новый. Продолжить?`,
      )) return;
    setBulkBusy(true);
    setError(null);
    try {
      await bulkMailboxes(ids, 'tag', tagId);
      setSelected(new Set());
      await Promise.all([load(page), loadTags()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось повесить тег');
    } finally {
      setBulkBusy(false);
    }
  };

  const runBulk = async (action: BulkMailboxAction) => {
    const ids = [...selected];
    if (!ids.length) return;
    if (action === 'delete'
      && !window.confirm(`Убрать выбранные ящики (${ids.length}) из инструмента? У провайдера они останутся.`)) return;
    setBulkBusy(true);
    setError(null);
    try {
      await bulkMailboxes(ids, action);
      setSelected(new Set());
      // Удаление ящиков меняет счётчики тегов в фильтре.
      await Promise.all([load(page), action === 'delete' ? loadTags() : Promise.resolve()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось применить действие');
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="text-base font-semibold text-zinc-900">Подключить ящики файлом</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Выгрузка провайдера как есть: CSV или XLSX. Колонки и сам провайдер распознаются сами — по хостам
          в файле, шапке выгрузки и домену ящика. Ящики Google Workspace подтягиваются из каталога сами, раз
          в час, и появляются выключенными: отметьте галочками те, с которых шлём. До проверки входа ящик в
          рассылку не идёт.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {uploading ? 'Загружаю…' : 'Выбрать файл'}
          </button>

          {googleReady ? (
            <button
              type="button"
              onClick={() => void runGoogleSync()}
              disabled={googleBusy}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50"
            >
              {googleBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
              {googleBusy ? 'Синхронизирую…' : 'Синхронизировать с Google'}
            </button>
          ) : null}

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
        </div>

        {result ? (
          <div className="mt-4 rounded-lg bg-zinc-50 p-3 text-sm">
            <p className="text-zinc-900">Подключено ящиков: {result.imported}</p>
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

        {notice ? <p className="mt-3 text-sm text-emerald-600">{notice}</p> : null}
        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
      </div>

      {/* Поиск и фильтр тегов — между подключением и списком: это про список,
          но нужны до того, как в нём начнёшь что-то искать глазами. */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Поиск по адресу"
            aria-label="Поиск по адресу"
            className="w-full rounded-lg border border-zinc-300 bg-white py-2 pl-9 pr-3 text-sm text-zinc-900"
          />
        </div>
        <TagFilterMenu
          tags={tags}
          untagged={untagged}
          selected={tagFilter}
          noTag={noTagFilter}
          onToggleTag={toggleTagFilter}
          onToggleNoTag={toggleNoTagFilter}
          onReset={resetTagFilter}
          onChanged={async () => {
            await Promise.all([loadTags(), load(page)]);
          }}
        />
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">Ящики ({total})</h2>
          <button
            type="button"
            onClick={() => void load(page)}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Обновить
          </button>
        </div>

        {/* Панель появляется только при выборе: пустая полоса кнопок над
            таблицей мозолила бы глаза в обычном режиме, когда действия
            построчные. Действия те же, что в строке, но на всю выборку. */}
        {selected.size > 0 ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-blue-50/60 px-5 py-2.5 text-sm">
            <span className="font-medium text-zinc-900">Выбрано: {selected.size}</span>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => void runBulk('recheck')}
              className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-blue-600 hover:bg-zinc-100 disabled:opacity-50"
            >
              Проверить
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => void runBulk('disable')}
              className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
            >
              Не использовать
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => void runBulk('enable')}
              className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
            >
              Использовать
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => void runBulk('delete')}
              className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              Удалить
            </button>
            <TagAssignMenu tags={tags} disabled={bulkBusy} onPick={(tagId) => void assignTag(tagId)} />
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => setSelected(new Set())}
              className="rounded-md px-2.5 py-1 text-xs text-zinc-500 hover:bg-zinc-100 disabled:opacity-50"
            >
              Снять выделение
            </button>
            {bulkBusy ? <Loader2 className="h-4 w-4 animate-spin text-zinc-400" /> : null}
          </div>
        ) : null}

        {loading ? (
          <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Загрузка…
          </div>
        ) : mailboxes.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-zinc-500">
            {appliedSearch || tagFilterKey || noTagFilter
              ? 'Под фильтр не попал ни один ящик.'
              : 'Ящиков пока нет — загрузите выгрузку провайдера.'}
          </p>
        ) : (
          <div className="relative">
            {paging ? (
              <div className="absolute inset-0 z-10 flex items-start justify-center bg-white/60 pt-10">
                <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
              </div>
            ) : null}
            <div className={`overflow-x-auto transition-opacity ${paging ? 'opacity-40' : ''}`}>
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-zinc-500">
                <tr className="border-b border-zinc-200">
                  <th className="w-10 pl-5 pr-2 py-2">
                    <input
                      type="checkbox"
                      aria-label="Выбрать все на странице"
                      checked={allOnPageSelected}
                      ref={(node) => {
                        // Частичный выбор — это третье состояние флажка, а не
                        // «снято»: иначе на половине выбранных строк шапка
                        // выглядит так же, как на пустой странице.
                        if (node) node.indeterminate = someOnPageSelected && !allOnPageSelected;
                      }}
                      onChange={toggleAllOnPage}
                      className="h-4 w-4 cursor-pointer rounded border-zinc-300"
                    />
                  </th>
                  <th className="px-3 py-2 font-medium">Ящик</th>
                  <th className="px-3 py-2 font-medium">Провайдер</th>
                  <th className="px-3 py-2 font-medium">Тег</th>
                  <th className="px-3 py-2 font-medium">В рассылке</th>
                  <th className="px-3 py-2 font-medium">В Google</th>
                  <th className="px-3 py-2 font-medium">Статус</th>
                  <th className="px-3 py-2 font-medium">Лимит/день</th>
                  <th className="px-3 py-2 font-medium">SMTP</th>
                  <th className="px-3 py-2 font-medium">IMAP</th>
                  <th className="px-5 py-2" />
                </tr>
              </thead>
              <tbody>
                {mailboxes.map((mailbox) => {
                  const status = MAILBOX_STATUS_LABELS[mailbox.status];
                  return (
                    <tr
                      key={mailbox.id}
                      className={`border-b border-zinc-100 last:border-0 ${selected.has(mailbox.id) ? 'bg-blue-50/40' : ''}`}
                    >
                      <td className="w-10 pl-5 pr-2 py-2.5">
                        <input
                          type="checkbox"
                          aria-label={`Выбрать ${mailbox.email}`}
                          checked={selected.has(mailbox.id)}
                          onChange={() => toggleOne(mailbox.id)}
                          className="h-4 w-4 cursor-pointer rounded border-zinc-300"
                        />
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="font-medium text-zinc-900">{mailbox.email}</div>
                        {mailbox.last_error ? (
                          <div className="mt-0.5 text-xs text-amber-600">{mailbox.last_error}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5 text-zinc-600">
                        <div>{providerLabel(mailbox.provider)}</div>
                        {/* Из какого Workspace пришёл ящик: аккаунтов может
                            быть несколько, и без этого не понять, чей он. */}
                        {mailbox.google_account ? (
                          <div className="mt-0.5 text-xs text-zinc-400">{mailbox.google_account}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5">
                        {mailbox.tag ? (
                          <TagChip name={mailbox.tag.name} />
                        ) : (
                          <span className="text-xs text-zinc-400">—</span>
                        )}
                      </td>
                      {/* Галочка прямо в строке: выбирать ящики по одному
                          удобнее здесь, а пачкой — панелью над таблицей. */}
                      <td className="px-3 py-2.5">
                        <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-zinc-600">
                          <input
                            type="checkbox"
                            checked={mailbox.enabled}
                            onChange={() =>
                              void act(mailbox.id, { action: mailbox.enabled ? 'disable' : 'enable' })
                            }
                            className="h-4 w-4 cursor-pointer rounded border-zinc-300"
                          />
                          Шлём
                        </label>
                      </td>
                      <td className="px-3 py-2.5">
                        {mailbox.google_state ? (
                          <span
                            className={`rounded-md px-2 py-0.5 text-xs font-medium ${
                              GOOGLE_STATE_LABELS[mailbox.google_state]?.className ?? 'bg-zinc-100 text-zinc-600'
                            }`}
                          >
                            {GOOGLE_STATE_LABELS[mailbox.google_state]?.text ?? mailbox.google_state}
                          </span>
                        ) : (
                          <span className="text-xs text-zinc-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {/* Ящик не в рассылке — портал в него не заходит, и
                            «Проверяется» висело бы вечно. */}
                        {mailbox.enabled ? (
                          <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${status.className}`}>
                            {status.text}
                          </span>
                        ) : (
                          <span className="text-xs text-zinc-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <input
                          type="number"
                          min={1}
                          max={500}
                          defaultValue={mailbox.daily_campaign_limit}
                          onBlur={(e) => {
                            const next = Number(e.target.value);
                            if (next && next !== mailbox.daily_campaign_limit) {
                              void act(mailbox.id, { dailyCampaignLimit: next });
                            }
                          }}
                          className="w-16 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900"
                        />
                      </td>
                      <td className="px-3 py-2.5 text-zinc-600">
                        {mailbox.smtp_host}:{mailbox.smtp_port}
                      </td>
                      <td className="px-3 py-2.5 text-zinc-600">
                        {mailbox.imap_host ? `${mailbox.imap_host}:${mailbox.imap_port}` : '—'}
                      </td>
                      <td className="px-5 py-2.5">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => void act(mailbox.id, { action: 'recheck' })}
                            className="rounded-md px-2 py-1 text-xs text-blue-600 hover:bg-zinc-100"
                          >
                            Проверить
                          </button>
                          <button
                            type="button"
                            onClick={() => void remove(mailbox)}
                            aria-label="Убрать ящик"
                            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-red-600"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        )}

        {total > PAGE_SIZE ? (
          <div className="flex items-center justify-center gap-4 border-t border-zinc-200 px-5 py-3 text-sm">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || paging}
              className="rounded-md px-3 py-1.5 text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"
            >
              ← Назад
            </button>
            <span className="inline-flex items-center gap-2 text-zinc-500">
              {paging ? <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" /> : null}
              Стр. {page} из {maxPage} · {total} ящиков
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
              disabled={page >= maxPage || paging}
              className="rounded-md px-3 py-1.5 text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"
            >
              Вперёд →
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
