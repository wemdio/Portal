'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, Pencil, Plus, RefreshCw, Search, X } from 'lucide-react';
import {
  bulkMailboxes,
  bulkMailboxLimits,
  deleteMailbox,
  fetchEgressIps,
  fetchMailboxes,
  fetchMailboxProbe,
  fetchMailboxTags,
  moveMailboxes,
  patchMailbox,
  startMailboxProbe,
  type BulkMailboxAction,
  type EgressIpDto,
  type MailboxDto,
  type MailboxTagDto,
  type ProbeResultDto,
} from './api';
import { AddMailboxesModal } from './AddMailboxesModal';
import { EgressMoveMenu } from './EgressPanel';
import { GOOGLE_STATE_LABELS, MAILBOX_STATUS_LABELS, providerLabel } from './labels';
import { TagAssignMenu, TagChip, TagFilterMenu, tagTones } from './MailboxTags';
import { RowActionsMenu } from './RowActionsMenu';
import { SenderModal } from './SenderModal';
import { SortableTh } from '@/components/ui/SortableTh';

const PAGE_SIZE = 30;
const EMPTY_SELECTION: ReadonlySet<string> = new Set();
/** Пауза между буквой и запросом: иначе поиск стоит запроса на символ. */
const SEARCH_DEBOUNCE_MS = 300;

/** initialEgressIp — адрес, по которому пришли из вкладки «Адреса отправки». */
export function MailboxesTab({ initialEgressIp = null }: { initialEgressIp?: string | null }) {
  const [mailboxes, setMailboxes] = useState<MailboxDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  // Отдельно от loading: первая загрузка рисует заглушку вместо таблицы, а
  // переход на другую страницу — кружок поверх уже показанных строк. Подменять
  // на заглушку и её тоже значит заставлять глаз заново искать, где он был.
  const [paging, setPaging] = useState(false);
  // «Добавить почты»: файл и каталог Google — в окне, список под ним свободен.
  const [addOpen, setAddOpen] = useState(false);
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

  // search — то, что набрано в поле; appliedSearch — то, что уже ушло в запрос.
  // Разделены, чтобы каждая буква не стоила похода на сервер, а список не
  // перерисовывался в процессе набора.
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const searchTimer = useRef<number | null>(null);
  const [tags, setTags] = useState<MailboxTagDto[]>([]);
  const toneByTag = useMemo(() => tagTones(tags), [tags]);
  const [untagged, setUntagged] = useState(0);
  const [tagFilter, setTagFilter] = useState<ReadonlySet<string>>(EMPTY_SELECTION);
  const [noTagFilter, setNoTagFilter] = useState(false);
  // Ключ строкой: Set в списке зависимостей useCallback сравнивается по ссылке,
  // и список перезагружался бы на каждый рендер.
  const tagFilterKey = [...tagFilter].sort().join(',');
  const [egressIps, setEgressIps] = useState<EgressIpDto[]>([]);
  // Фильтр по адресу — клик по адресу во вкладке «Адреса отправки».
  const [egressFilter, setEgressFilter] = useState<string | null>(initialEgressIp);
  // Сортировка по столбцу (по всему списку, считает сервер): клик — по возрастанию,
  // ещё клик — по убыванию, третий — обратно по ящику.
  const [sort, setSort] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);

  const load = useCallback(async (targetPage: number) => {
    try {
      const { mailboxes: rows, total: count } = await fetchMailboxes({
        page: targetPage,
        search: appliedSearch || undefined,
        tagIds: tagFilterKey ? tagFilterKey.split(',') : undefined,
        noTag: noTagFilter || undefined,
        egressIp: egressFilter ?? undefined,
        sort: sort?.key,
        dir: sort?.direction,
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
  }, [appliedSearch, tagFilterKey, noTagFilter, egressFilter, sort]);

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

  const loadEgress = useCallback(async () => {
    try {
      const res = await fetchEgressIps();
      setEgressIps(res.ips);
    } catch {
      /* адреса не доехали — меню «На адрес» просто не покажется */
    }
  }, []);

  // Адреса здесь нужны только меню «На адрес»: их пульс опрашивает своя вкладка.
  useEffect(() => {
    void loadEgress();
  }, [loadEgress]);

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
    // Ящики после загрузки проверяются воркером — подтягиваем статусы, пока
    // есть хоть один в очереди на проверку. Сортировка по email стабильна,
    // поэтому опрос больше дёргает строки местами.
    const timer = window.setInterval(() => void load(page), 15_000);
    return () => window.clearInterval(timer);
  }, [load, page]);

  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const act = async (id: string, body: Record<string, unknown>) => {
    await patchMailbox(id, body);
    await load(page);
  };

  // Проверочная отправка: письмо с ящика на контрольный адрес и разбор
  // заголовков доставленного. Отправляет воркер на sender-хосте, здесь только
  // заводим пробу и показываем результат, когда он готов.
  const [probeBusy, setProbeBusy] = useState<string | null>(null);
  const [probeDetail, setProbeDetail] = useState<ProbeResultDto | null>(null);

  const runProbe = async (mailbox: MailboxDto) => {
    setProbeBusy(mailbox.id);
    setError(null);
    setNotice(null);
    try {
      await startMailboxProbe(mailbox.id);
      setNotice(`Проверочное письмо с ${mailbox.email} отправляется — результат появится в строке ящика через пару минут.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось запустить проверку');
    } finally {
      setProbeBusy(null);
    }
  };

  const openProbeDetail = async (mailbox: MailboxDto) => {
    setError(null);
    try {
      const { probe } = await fetchMailboxProbe(mailbox.id);
      if (probe) setProbeDetail(probe);
      else setNotice('Проверок отправки с этого ящика ещё не было.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить результат проверки');
    }
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

  const onSort = (key: string) => {
    setSort((cur) => {
      if (!cur || cur.key !== key) return { key, direction: 'asc' };
      return cur.direction === 'asc' ? { key, direction: 'desc' } : null;
    });
    resetToFirstPage();
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

  // Крестик сбрасывает поиск сразу, без паузы ввода.
  const clearSearch = () => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    setSearch('');
    setAppliedSearch('');
    resetToFirstPage();
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

  const filterByEgress = (ip: string | null) => {
    setEgressFilter(ip);
    resetToFirstPage();
  };

  /** «На адрес»: ящик закреплён за адресом, перенос — осознанное действие. */
  const moveToEgress = async (ip: string) => {
    const ids = [...selected];
    if (!ids.length) return;
    if (!window.confirm(
      `Перенести выбранные ящики (${ids.length}) на адрес ${ip}? Следующий вход в почту у них будет уже с нового адреса.`,
    )) return;
    setBulkBusy(true);
    setError(null);
    try {
      await moveMailboxes(ids, ip);
      setSelected(new Set());
      await Promise.all([load(page), loadEgress()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось перенести ящики');
    } finally {
      setBulkBusy(false);
    }
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

  // Лимиты на выборку: поля в панели действий, пустое поле не меняется.
  const [bulkNew, setBulkNew] = useState('');
  const [bulkTotal, setBulkTotal] = useState('');
  const applyLimits = async () => {
    const ids = [...selected];
    const dailyCampaignLimit = bulkNew.trim() ? Number(bulkNew) : undefined;
    const dailyTotalLimit = bulkTotal.trim() ? Number(bulkTotal) : undefined;
    if (!ids.length || (dailyCampaignLimit === undefined && dailyTotalLimit === undefined)) return;
    if ([dailyCampaignLimit, dailyTotalLimit].some((v) => v !== undefined && !(v >= 1 && v <= 500))) {
      setError('Лимит — число от 1 до 500');
      return;
    }
    setBulkBusy(true);
    setError(null);
    try {
      await bulkMailboxLimits(ids, { dailyCampaignLimit, dailyTotalLimit });
      setBulkNew('');
      setBulkTotal('');
      await load(page);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось задать лимиты');
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
      {addOpen ? (
        <AddMailboxesModal
          onClose={() => setAddOpen(false)}
          onChanged={() => void Promise.all([load(page), loadTags()])}
        />
      ) : null}

      {notice ? <p className="text-sm text-emerald-600">{notice}</p> : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {/* Поиск, фильтр тегов и «Добавить почты» — над списком: это про список,
          и нужны до того, как в нём начнёшь что-то искать глазами. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Поиск по адресу"
            aria-label="Поиск по адресу"
            className="w-full rounded-lg border border-zinc-300 bg-white py-2 pl-9 pr-9 text-sm text-zinc-900"
          />
          {search && (
            <button
              type="button"
              onClick={clearSearch}
              aria-label="Очистить поиск"
              title="Очистить поиск"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            >
              <X className="h-4 w-4" />
            </button>
          )}
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
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
        >
          <Plus className="h-4 w-4" />
          Добавить почты
        </button>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white">
        {/* Панель действий встаёт на место заголовка, а не под него: иначе при
            первой галочке список съезжает вниз и выбранная строка уходит из-под
            курсора. Высота у обоих вариантов одна. Действия те же, что в
            строке, но на всю выборку. */}
        {selected.size > 0 ? (
          <div className="flex min-h-12 flex-wrap items-center gap-2 rounded-t-xl border-b border-zinc-200 bg-blue-50/60 px-5 py-2 text-sm">
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
            <EgressMoveMenu ips={egressIps} disabled={bulkBusy} onPick={(ip) => void moveToEgress(ip)} />
            <div className="flex items-center gap-1" title="Новых / всего писем в день на каждый выбранный ящик">
              <input
                type="number"
                min={1}
                max={500}
                placeholder="новых"
                value={bulkNew}
                onChange={(e) => setBulkNew(e.target.value)}
                className="w-16 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900"
              />
              <span className="text-zinc-400">/</span>
              <input
                type="number"
                min={1}
                max={500}
                placeholder="всего"
                value={bulkTotal}
                onChange={(e) => setBulkTotal(e.target.value)}
                className="w-16 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900"
              />
              <button
                type="button"
                disabled={bulkBusy || (!bulkNew.trim() && !bulkTotal.trim())}
                onClick={() => void applyLimits()}
                className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
              >
                Задать лимиты
              </button>
            </div>
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
        ) : (
        <div className="flex min-h-12 items-center justify-between border-b border-zinc-200 px-5 py-2">
          <h2 className="text-base font-semibold text-zinc-900">
            Ящики ({total})
            {egressFilter ? (
              <span className="ml-2 font-mono text-xs font-normal text-zinc-500">адрес {egressFilter}</span>
            ) : null}
            {egressFilter ? (
              <button
                type="button"
                onClick={() => filterByEgress(null)}
                className="ml-2 rounded-md px-2 py-0.5 text-xs font-normal text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700"
              >
                Показать ящики всех адресов
              </button>
            ) : null}
          </h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void load(page)}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Обновить
            </button>
          </div>
        </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Загрузка…
          </div>
        ) : mailboxes.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-zinc-500">
            {appliedSearch || tagFilterKey || noTagFilter || egressFilter
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
                  <SortableTh label="Ящик" sortKey="email" sort={sort} onSort={onSort} />
                  <SortableTh label="Провайдер" sortKey="provider" sort={sort} onSort={onSort} />
                  <th className="px-3 py-2 font-medium">Тег</th>
                  <SortableTh label="Адрес отправки" sortKey="egress" sort={sort} onSort={onSort} />
                  <SortableTh label="Статус" sortKey="status" sort={sort} onSort={onSort} />
                  <SortableTh label="Здоровье" sortKey="health" sort={sort} onSort={onSort} />
                  <th className="px-3 py-2 font-medium" title="Новых писем в день / всего писем в день вместе с напоминаниями">
                    <span className="inline-flex items-center gap-1">
                      <SortableTh label="Новых" sortKey="new" sort={sort} onSort={onSort} inline />
                      <span className="text-zinc-300">/</span>
                      <SortableTh label="всего" sortKey="total" sort={sort} onSort={onSort} inline />
                      <span>в день</span>
                    </span>
                  </th>
                  <th className="px-5 py-2 text-right font-medium">Действия</th>
                </tr>
              </thead>
              <tbody>
                {mailboxes.map((mailbox) => {
                  const status = MAILBOX_STATUS_LABELS[mailbox.status];
                  const googleProblem = mailbox.google_state ? GOOGLE_STATE_LABELS[mailbox.google_state] : undefined;
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
                        {/* Колонка уже на ~30%: длинные пометки переносятся, а не растягивают таблицу. */}
                        <div className="max-w-[390px]">
                        <div className="font-medium text-zinc-900">{mailbox.email}</div>
                        {mailbox.last_error ? (
                          <div className="mt-0.5 text-xs text-amber-600">{mailbox.last_error}</div>
                        ) : null}
                        {mailbox.status === 'failed' && mailbox.enabled ? (
                          <div className="mt-0.5 text-xs text-zinc-500">{recheckNote(mailbox.next_recheck_at)}</div>
                        ) : null}
                        <SenderNameField
                          value={mailbox.display_name ?? ''}
                          onSave={(next) => act(mailbox.id, { displayName: next })}
                        />
                        {mailbox.probe ? (
                          <button
                            type="button"
                            onClick={() => void openProbeDetail(mailbox)}
                            className={`mt-1 block text-left text-xs ${
                              mailbox.probe.status === 'done'
                                ? mailbox.probe.passed ? 'text-emerald-600' : 'text-red-600'
                                : 'text-amber-600'
                            } underline-offset-2 hover:underline`}
                          >
                            {mailbox.probe.status === 'done'
                              ? mailbox.probe.passed
                                ? 'Проверка отправки: заголовки не тронуты'
                                : 'Проверка отправки: провайдер переписывает заголовки'
                              : mailbox.probe.status === 'failed'
                                ? `Проверка отправки не прошла: ${mailbox.probe.error ?? 'без деталей'}`
                                : 'Проверка отправки идёт…'}
                          </button>
                        ) : null}
                        </div>
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
                          <TagChip name={mailbox.tag.name} tone={toneByTag.get(mailbox.tag.id)} />
                        ) : (
                          <span className="text-xs text-zinc-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {mailbox.egress_ip ? (
                          <span className="font-mono text-xs text-zinc-600">{mailbox.egress_ip}</span>
                        ) : (
                          <span className="text-xs text-zinc-400" title="Адрес выдаётся автоматически в течение минуты">
                            ждёт адреса
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {/* Заблокирован или пропал в Google — это главное о
                            ящике: синк сам снял его с рассылки, и статус входа
                            тут уже ничего не скажет. Ящик не в рассылке —
                            портал в него не заходит, и «Проверяется» висело бы
                            вечно. */}
                        {googleProblem ? (
                          <span className={`whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ${googleProblem.className}`}>
                            {googleProblem.text}
                          </span>
                        ) : mailbox.enabled ? (
                          <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${status.className}`}>
                            {status.text}
                          </span>
                        ) : (
                          <span
                            className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500"
                            title="Ящик не в рассылке: письма с него не уходят"
                          >
                            Отключён
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <HealthBadge health={mailbox.health} />
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min={1}
                            max={500}
                            title="Новых (первых) писем в день"
                            // key по значению: поле с defaultValue само не обновляется после
                            // массовой правки лимитов — без этого показывало старое число.
                            key={`new-${mailbox.id}-${mailbox.daily_campaign_limit}`}
                            defaultValue={mailbox.daily_campaign_limit}
                            onBlur={(e) => {
                              const next = Number(e.target.value);
                              if (next && next !== mailbox.daily_campaign_limit) {
                                void act(mailbox.id, { dailyCampaignLimit: next });
                              }
                            }}
                            className="w-16 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900"
                          />
                          <span className="text-zinc-400">/</span>
                          <input
                            type="number"
                            min={1}
                            max={500}
                            title="Всего писем в день вместе с напоминаниями"
                            key={`total-${mailbox.id}-${mailbox.daily_total_limit}`}
                            defaultValue={mailbox.daily_total_limit}
                            onBlur={(e) => {
                              const next = Number(e.target.value);
                              if (next && next !== mailbox.daily_total_limit) {
                                void act(mailbox.id, { dailyTotalLimit: next });
                              }
                            }}
                            className="w-16 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900"
                          />
                        </div>
                        <div
                          className="mt-1 text-[11px] text-zinc-500"
                          title="Сегодня ушло: новых писем из лимита «новых» и всего писем из лимита «всего» (день по UTC)"
                        >
                          сегодня:{' '}
                          <span className={(mailbox.sent_today?.first ?? 0) >= mailbox.daily_campaign_limit ? 'font-medium text-amber-600' : ''}>
                            {mailbox.sent_today?.first ?? 0} / {mailbox.daily_campaign_limit}
                          </span>
                          {' – '}
                          <span className={(mailbox.sent_today?.total ?? 0) >= mailbox.daily_total_limit ? 'font-medium text-amber-600' : ''}>
                            {mailbox.sent_today?.total ?? 0} / {mailbox.daily_total_limit}
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-2.5 text-right">
                        <RowActionsMenu
                          items={[
                            { label: 'Проверить вход', title: 'Проверить вход по SMTP/IMAP', onClick: () => void act(mailbox.id, { action: 'recheck' }) },
                            {
                              label: probeBusy === mailbox.id ? 'Проверка отправки…' : 'Проверка отправки',
                              title: 'Отправить проверочное письмо на контрольный адрес и сравнить заголовки доставленного',
                              disabled: probeBusy === mailbox.id,
                              onClick: () => void runProbe(mailbox),
                            },
                            mailbox.enabled
                              ? { label: 'Не использовать', title: 'Снять ящик с рассылки', onClick: () => void act(mailbox.id, { action: 'disable' }) }
                              : { label: 'Использовать', title: 'Вернуть ящик в рассылку', onClick: () => void act(mailbox.id, { action: 'enable' }) },
                            { label: 'Удалить', danger: true, onClick: () => void remove(mailbox) },
                          ]}
                        />
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

      {/* Разбор проверочной отправки: построчно, что отправили и что доставил
          провайдер. Одно окно — для любого ящика, открытое из строки. */}
      {probeDetail ? (
        <SenderModal
          title="Проверка отправки"
          subtitle={
            probeDetail.status === 'done'
              ? probeDetail.passed
                ? 'Заголовки доставленного письма совпадают с отправленными'
                : 'Есть расхождения — провайдер меняет письмо при доставке'
              : probeDetail.status === 'failed'
                ? probeDetail.error ?? 'Проверка не прошла'
                : 'Письмо отправлено, ждём доставки на контрольный адрес'
          }
          onClose={() => setProbeDetail(null)}
          footer={
            <button
              type="button"
              onClick={() => setProbeDetail(null)}
              className="rounded-lg px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
            >
              Закрыть
            </button>
          }
        >
          {probeDetail.status === 'done' && probeDetail.result?.length ? (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-zinc-500">
                <tr className="border-b border-zinc-200">
                  <th className="py-2 pr-3 font-medium">Проверка</th>
                  <th className="py-2 pr-3 font-medium">Отправляли</th>
                  <th className="py-2 pr-3 font-medium">Доставилось</th>
                  <th className="py-2 font-medium">Итог</th>
                </tr>
              </thead>
              <tbody>
                {probeDetail.result.map((row, index) => (
                  <tr key={`${row.check}-${index}`} className="border-b border-zinc-100 last:border-0">
                    <td className="py-2 pr-3 font-medium text-zinc-900">{row.check}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-zinc-600">{row.expected ?? '—'}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-zinc-600">{row.actual ?? '—'}</td>
                    <td className={`py-2 text-xs ${row.ok ? 'text-emerald-600' : 'text-red-600'}`}>
                      {row.ok ? 'ок' : 'расхождение'}
                      {row.note ? <div className="mt-0.5 font-sans text-zinc-500">{row.note}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="py-6 text-sm text-zinc-500">
              {probeDetail.error ?? 'Результата пока нет — письмо ещё идёт до контрольного адреса.'}
            </p>
          )}
        </SenderModal>
      ) : null}
    </div>
  );
}

/**
 * Имя отправителя в письмах («Иван <box@dom>»). Правится только по карандашу:
 * открытое поле в каждой строке ловило случайные клики и выглядело как форма.
 * Enter или клик мимо — сохранить, Esc — отменить.
 */
/** Оценка здоровья: зелёная от 85, жёлтая 60–84, красная ниже; «—» — данных мало. */
/** Подпись под упавшим ящиком: когда он перепроверится сам. */
function recheckNote(nextRecheckAt: string | null | undefined): string {
  if (!nextRecheckAt) return 'Автопроверка остановлена — нажмите «Проверить вход»';
  const at = new Date(nextRecheckAt);
  if (at.getTime() <= Date.now()) return 'Перепроверка — в ближайшую минуту';
  const time = at.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
  return `Перепроверится сам ${time} (МСК)`;
}

function HealthBadge({ health }: { health: { score: number | null; sent: number; bounced: number; failed: number } | null }) {
  if (!health || health.score === null) {
    return (
      <span className="text-xs text-zinc-400" title={health ? `За 14 дней отправлено ${health.sent} — для оценки нужно хотя бы 20` : 'Нет данных'}>
        —
      </span>
    );
  }
  const tone =
    health.score >= 85 ? 'bg-emerald-50 text-emerald-700' : health.score >= 60 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700';
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-xs font-medium tabular-nums ${tone}`}
      title={`За 14 дней: отправлено ${health.sent}, отбоев ${health.bounced}, ошибок отправки ${health.failed}`}
    >
      {health.score}%
    </span>
  );
}

function SenderNameField({ value, onSave }: { value: string; onSave: (next: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  // Enter сохраняет, а следом поле теряет фокус и зовёт сохранение ещё раз.
  const busy = useRef(false);

  const start = () => {
    setDraft(value);
    setEditing(true);
  };

  const save = async () => {
    if (busy.current) return;
    const next = draft.trim();
    if (next === value) {
      setEditing(false);
      return;
    }
    busy.current = true;
    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
    } catch {
      /* не сохранилось — поле остаётся открытым с набранным */
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="group mt-1 flex items-center gap-1 text-xs">
        <span className={value ? 'text-zinc-600' : 'text-zinc-400'}>{value || 'Имя не задано'}</span>
        <button
          type="button"
          onClick={start}
          aria-label="Изменить имя отправителя"
          title="Изменить имя отправителя"
          className="rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
        >
          <Pencil className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <div className="mt-1 flex items-center gap-1">
      <input
        type="text"
        value={draft}
        autoFocus
        disabled={saving}
        placeholder="Имя отправителя"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') setEditing(false);
        }}
        onBlur={() => void save()}
        className="w-44 rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-xs text-zinc-900"
      />
      {saving ? (
        <Loader2 className="h-3 w-3 animate-spin text-zinc-400" />
      ) : (
        // onMouseDown, а не onClick: иначе blur поля сохранит раньше клика.
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            void save();
          }}
          aria-label="Сохранить имя"
          className="rounded p-0.5 text-emerald-600 hover:bg-zinc-100"
        >
          <Check className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
