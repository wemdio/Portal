'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Search, Tag } from 'lucide-react';
import { fetchMailboxTags, fetchMailboxes, type MailboxDto, type MailboxTagDto } from './api';
import { MAILBOX_STATUS_LABELS, providerLabel } from './labels';
import { TagChip } from './MailboxTags';
import { SenderModal } from './SenderModal';

/** Ящик в выборке: адрес храним рядом с id, чтобы показать его без повторного запроса. */
export interface PickedMailbox {
  id: string;
  email: string;
  /**
   * Состояние на момент выбора — настройки папки по нему сразу говорят,
   * сколько выбранных ящиков может слать. У ящиков, пришедших из кампании
   * списком адресов, его нет.
   */
  status?: MailboxDto['status'];
  enabled?: boolean;
}

function toPicked(mailbox: MailboxDto): PickedMailbox {
  return { id: mailbox.id, email: mailbox.email, status: mailbox.status, enabled: mailbox.enabled };
}

const PAGE_SIZE = 200;
/** Пауза перед запросом: человек печатает домен, а не отправляет запрос на каждую букву. */
const SEARCH_DEBOUNCE_MS = 250;
/** Сколько страниц вытянем, собирая ящики тега: 200 × 5 — весь пул с запасом. */
const MAX_TAG_PAGES = 5;

interface Props {
  initial: PickedMailbox[];
  onSave: (picked: PickedMailbox[]) => void;
  onClose: () => void;
  /** Подпись под заголовком: у кампании и у папки ящики значат разное. */
  subtitle?: string;
}

/**
 * Выбор ящиков для кампании.
 *
 * Ящиков бывает несколько сотен, поэтому это поиск, а не список: строка фильтрует
 * по адресу на стороне БД, выбранное живёт отдельно от результатов поиска и
 * переживает смену запроса. Ящик не в статусе «Готов» выбрать можно — отправка
 * всё равно берёт только проверенные, и такой ящик просто подключится к
 * кампании сам, когда пройдёт проверку.
 */
export function MailboxPickerModal({
  initial,
  onSave,
  onClose,
  subtitle = 'Письма кампании уходят по очереди со всех выбранных ящиков',
}: Props) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<MailboxDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<PickedMailbox[]>(initial);
  const [tags, setTags] = useState<MailboxTagDto[]>([]);
  // Какой тег сейчас докладываем: ящики тега доезжают запросом, и на пуле в
  // несколько сотен это не мгновенно.
  const [tagBusy, setTagBusy] = useState<string | null>(null);
  /**
   * Какие ящики лежат в теге — заполняется, когда тег хоть раз нажали.
   *
   * До этого галочки на теге нет, и это честно: связь «тег → ящики» живёт на
   * сервере, и утверждать по счётчику, что тег уже целиком в выборке, нельзя —
   * те же двадцать ящиков могли быть выбраны руками из другого тега.
   */
  const [tagMailboxIds, setTagMailboxIds] = useState<Map<string, Set<string>>>(new Map());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchMailboxTags();
        if (!cancelled) setTags(res.tags);
      } catch {
        /* теги не доехали — остаётся обычный поиск по адресу */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchMailboxes({ search: query, pageSize: PAGE_SIZE });
        if (cancelled) return;
        setRows(res.mailboxes);
        setTotal(res.total);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Не удалось загрузить ящики');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query]);

  const pickedIds = useMemo(() => new Set(picked.map((m) => m.id)), [picked]);
  const allShownPicked = rows.length > 0 && rows.every((row) => pickedIds.has(row.id));

  const toggle = (mailbox: MailboxDto) => {
    setPicked((prev) =>
      prev.some((m) => m.id === mailbox.id)
        ? prev.filter((m) => m.id !== mailbox.id)
        : [...prev, toPicked(mailbox)],
    );
  };

  /**
   * Весь тег разом.
   *
   * Ящики тега берём запросом, а не из того, что сейчас на экране: экран
   * показывает первые две сотни и отфильтрован строкой поиска, а «загнать тег
   * в кампанию» означает весь тег целиком, включая то, что не видно.
   *
   * Повторное нажатие снимает тег — иначе взятый по ошибке тег из двадцати
   * ящиков пришлось бы разбирать галочками.
   */
  const toggleTag = async (tag: MailboxTagDto) => {
    setTagBusy(tag.id);
    setError(null);
    try {
      const collected: PickedMailbox[] = [];
      for (let page = 1; page <= MAX_TAG_PAGES; page += 1) {
        const res = await fetchMailboxes({ tagIds: [tag.id], page, pageSize: PAGE_SIZE });
        collected.push(...res.mailboxes.map(toPicked));
        if (collected.length >= res.total || res.mailboxes.length < PAGE_SIZE) break;
      }
      if (!collected.length) return;

      setTagMailboxIds((prev) => new Map(prev).set(tag.id, new Set(collected.map((m) => m.id))));
      setPicked((prev) => {
        const known = new Set(prev.map((m) => m.id));
        const allIn = collected.every((m) => known.has(m.id));
        if (allIn) {
          const drop = new Set(collected.map((m) => m.id));
          return prev.filter((m) => !drop.has(m.id));
        }
        return [...prev, ...collected.filter((m) => !known.has(m.id))];
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : `Не удалось взять ящики тега «${tag.name}»`);
    } finally {
      setTagBusy(null);
    }
  };

  const toggleShown = () => {
    setPicked((prev) => {
      if (allShownPicked) {
        const shown = new Set(rows.map((r) => r.id));
        return prev.filter((m) => !shown.has(m.id));
      }
      const known = new Set(prev.map((m) => m.id));
      return [...prev, ...rows.filter((r) => !known.has(r.id)).map(toPicked)];
    });
  };

  return (
    <SenderModal
      title="Ящики для отправки"
      subtitle={subtitle}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-sm text-zinc-500">Выбрано: {picked.length}</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => onSave(picked)}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
          >
            Сохранить
          </button>
        </>
      }
    >
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
          placeholder="Поиск по адресу: домен, имя, часть адреса"
          className="w-full rounded-xl border border-zinc-300 bg-white py-2.5 pl-9 pr-3 text-sm text-zinc-900"
        />
      </div>

      {/* Тег одной кнопкой: частый случай — «в эту кампанию шлём с ящиков
          такого-то клиента», и это ровно один тег, а не двадцать галочек. */}
      {tags.length ? (
        <div className="mt-3">
          <p className="mb-1.5 text-xs text-zinc-500">
            Взять целиком по тегу — нажмите; повторное нажатие снимает весь тег:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => {
              // «Выбран» — когда в выборке уже столько ящиков этого тега,
              // сколько в нём есть. Считаем по счётчику тега, а не по экрану:
              // на экране первые две сотни и результат поиска.
              const inPicked = picked.filter((m) => tagMailboxIds.get(tag.id)?.has(m.id)).length;
              const full = tag.mailboxes > 0 && inPicked >= tag.mailboxes;
              return (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => void toggleTag(tag)}
                  disabled={tagBusy != null}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors disabled:opacity-50 ${
                    full ? 'bg-blue-600 text-white' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
                  }`}
                >
                  {tagBusy === tag.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : full ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <Tag className="h-3 w-3 opacity-60" />
                  )}
                  {tag.name}
                  <span className={full ? 'opacity-80' : 'text-zinc-400'}>{tag.mailboxes}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
        <span>
          {loading ? 'Загружаю…' : `Найдено: ${total}`}
          {!loading && total > rows.length ? ` · показаны первые ${rows.length}, уточните поиск` : ''}
        </span>
        {rows.length ? (
          <button
            type="button"
            onClick={toggleShown}
            className="rounded-lg px-2.5 py-1.5 text-xs text-blue-600 transition-colors hover:bg-blue-50"
          >
            {allShownPicked ? 'Снять показанные' : 'Выбрать показанные'}
          </button>
        ) : null}
      </div>

      <div className="mt-2 divide-y divide-zinc-100 rounded-xl border border-zinc-200">
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Загрузка…
          </div>
        ) : rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-zinc-500">
            {query ? 'Ничего не нашлось — попробуйте другой кусок адреса.' : 'Ящиков пока нет — подключите их на вкладке «Ящики».'}
          </p>
        ) : (
          rows.map((mailbox) => {
            const status = MAILBOX_STATUS_LABELS[mailbox.status];
            const active = pickedIds.has(mailbox.id);
            return (
              <label
                key={mailbox.id}
                className={`flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors ${
                  active ? 'bg-blue-50/60' : 'hover:bg-zinc-100'
                }`}
              >
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() => toggle(mailbox)}
                  className="h-4 w-4 cursor-pointer rounded border-zinc-300"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-zinc-900">{mailbox.email}</span>
                {mailbox.tag ? <TagChip name={mailbox.tag.name} /> : null}
                {/* Снятая галочка на вкладке «Ящики» сильнее выбора в кампании:
                    планировщик такой ящик пропустит, и об этом надо сказать
                    здесь, а не оставлять человека гадать, почему письма стоят. */}
                {!mailbox.enabled ? (
                  <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs text-amber-700">Не в рассылке</span>
                ) : null}
                <span className="hidden text-xs text-zinc-400 sm:block">{providerLabel(mailbox.provider)}</span>
                <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${status.className}`}>{status.text}</span>
              </label>
            );
          })
        )}
      </div>

      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
    </SenderModal>
  );
}
