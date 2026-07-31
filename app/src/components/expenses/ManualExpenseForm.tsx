'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';

import VendorSelect, { type VendorOption } from '@/components/expenses/VendorSelect';
import { expensesFetch, formatMoney, mskToday } from '@/lib/expenses/client';
import { useUser } from '@/lib/UserProvider';

interface ManualExpense {
  id: string;
  occurred_on: string;
  amount: number | string;
  currency: string;
  payer: string;
  comment: string | null;
  created_by: string;
  created_at: string;
}

const CURRENCIES = ['RUB', 'USD', 'EUR', 'KZT', 'CNY', 'GBP'];

interface EditDraft {
  occurredOn: string;
  amount: string;
  currency: string;
  comment: string;
}

function matchesSearch(item: ManualExpense, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [item.occurred_on, String(item.amount), item.currency, item.payer, item.comment ?? '']
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

/**
 * Форма ручной траты и список уже внесённых.
 *
 * Правка и удаление здесь не украшение: опечатка в сумме — обычное дело для
 * ручного ввода, и без них форма превращается в append-only свалку, которую
 * чинят SQL-запросом, то есть никогда. Права проверяет сервер (автор или
 * админ), поэтому кнопки видны всем — отказ приходит текстом.
 */
export default function ManualExpenseForm({
  range,
  vendors,
  onVendorCreated,
  onChanged,
}: {
  range: { from: string; to: string };
  vendors: VendorOption[];
  onVendorCreated: (vendor: VendorOption) => void;
  onChanged: () => void;
}) {
  const { userId } = useUser();

  const [items, setItems] = useState<ManualExpense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);

  // `today` вычисляется один раз при монтировании: вызов Date в теле рендера —
  // импьюрность, на которую ругается react-hooks/purity.
  const [today] = useState(() => mskToday());
  const [occurredOn, setOccurredOn] = useState(today);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('RUB');
  const [vendorId, setVendorId] = useState('');
  const [payer, setPayer] = useState('');
  const [comment, setComment] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Перезагрузка списка — через счётчик, а не через прямой вызов из обработчика:
  // так у запроса всегда есть AbortController и защита от гонки, одинаковые и
  // для смены периода, и для сохранения записи.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((prev) => prev + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    void (async () => {
      setLoading(true);
      try {
        const res = await expensesFetch<{ items: ManualExpense[] }>(
          `/manual?from=${range.from}&to=${range.to}`,
          { signal: controller.signal },
        );
        if (!active) return;
        setItems(res.items);
        setError(null);
      } catch (e) {
        if (!active) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : 'Не удалось загрузить список ручных трат');
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [range.from, range.to, reloadKey]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await expensesFetch('/manual', {
        method: 'POST',
        body: JSON.stringify({
          occurredOn,
          amount: Number(amount),
          currency,
          vendorId: vendorId || null,
          payer: payer.trim() || undefined,
          comment: comment.trim() || undefined,
        }),
      });
      setAmount('');
      setComment('');
      // Запись вне выбранного периода в списке не появится — молчать об этом
      // нельзя, иначе выглядит как «не сохранилось».
      if (occurredOn < range.from || occurredOn > range.to) {
        setNotice('Трата сохранена, но её дата вне выбранного периода — расширь период, чтобы увидеть её.');
      }
      reload();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить трату');
    } finally {
      setSaving(false);
    }
  }

  function startEdit(item: ManualExpense) {
    setEditingId(item.id);
    setConfirmDeleteId(null);
    setDraft({
      occurredOn: item.occurred_on,
      amount: String(item.amount),
      currency: item.currency,
      comment: item.comment ?? '',
    });
  }

  async function saveEdit(id: string) {
    if (!draft) return;
    setError(null);
    setNotice(null);
    try {
      await expensesFetch(`/manual/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          occurredOn: draft.occurredOn,
          amount: Number(draft.amount),
          currency: draft.currency,
          comment: draft.comment,
        }),
      });
      setEditingId(null);
      setDraft(null);
      reload();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить правку');
    }
  }

  async function remove(id: string) {
    setError(null);
    setNotice(null);
    try {
      await expensesFetch(`/manual/${id}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      reload();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось удалить запись');
    }
  }

  const visible = items.filter((item) => matchesSearch(item, search));

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3">
      <h3 className="text-sm font-semibold text-zinc-900">Ручная трата</h3>
      <p className="mt-0.5 text-xs text-zinc-500">
        Личная карта и всё, чего нет в банковских выгрузках. Вендор выбирается сразу — тогда запись не попадёт
        в очередь разметки.
      </p>

      <form onSubmit={submit} className="mt-2 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
          Дата
          <input
            type="date"
            value={occurredOn}
            max={today}
            onChange={(e) => setOccurredOn(e.target.value)}
            required
            className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
          Сумма
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            className="w-28 rounded-lg border border-zinc-200 px-2 py-1 text-right text-xs tabular-nums text-zinc-700"
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
          Валюта
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
          >
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-col gap-1 text-[11px] text-zinc-500">
          Вендор
          <VendorSelect
            value={vendorId}
            onChange={setVendorId}
            options={vendors}
            onCreated={onVendorCreated}
            emptyLabel="Без вендора (уйдёт в очередь)"
          />
        </div>
        <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
          Плательщик
          <input
            type="text"
            value={payer}
            onChange={(e) => setPayer(e.target.value)}
            placeholder="ceo_personal_card"
            className="w-36 rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
          />
        </label>
        <label className="flex min-w-[160px] flex-1 flex-col gap-1 text-[11px] text-zinc-500">
          Комментарий
          <input
            type="text"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
          />
        </label>
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs text-white disabled:opacity-40"
        >
          {saving ? 'Сохраняю…' : 'Добавить'}
        </button>
      </form>

      {currency !== 'RUB' ? (
        <p className="mt-1.5 text-[11px] text-zinc-400">
          Курс ЦБ подтягивается ночным синком: до него трата будет видна в KPI «без курса ЦБ» и не войдёт в
          рублёвый итог.
        </p>
      ) : null}

      {error ? <div className="mt-2 text-xs text-red-600">{error}</div> : null}
      {notice ? <div className="mt-2 text-xs text-amber-700">{notice}</div> : null}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск по комментарию, сумме, дате"
          aria-label="Поиск по ручным тратам"
          className="w-56 rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
        />
        <span className="text-[11px] text-zinc-400">
          Список за выбранный период; фильтры по источнику и категории на него не влияют.
        </span>
      </div>

      <div className="mt-1.5 overflow-x-auto">
        <table className="w-full min-w-[560px] text-xs">
          <tbody>
            {loading ? (
              <tr>
                <td className="py-2 text-zinc-400">Загружаю…</td>
              </tr>
            ) : null}

            {!loading && visible.length === 0 ? (
              <tr>
                <td className="py-2 text-zinc-400">
                  {items.length === 0 ? 'Ручных трат за период нет.' : 'Под поиск ничего не подошло.'}
                </td>
              </tr>
            ) : null}

            {visible.map((item) =>
              editingId === item.id && draft ? (
                <tr key={item.id} className="border-t border-zinc-100">
                  <td colSpan={5} className="py-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <input
                        type="date"
                        value={draft.occurredOn}
                        max={today}
                        onChange={(e) => setDraft({ ...draft, occurredOn: e.target.value })}
                        aria-label="Дата траты"
                        className="rounded-lg border border-zinc-200 px-2 py-1 text-xs"
                      />
                      <input
                        type="number"
                        step="0.01"
                        min="0.01"
                        value={draft.amount}
                        onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
                        aria-label="Сумма траты"
                        className="w-28 rounded-lg border border-zinc-200 px-2 py-1 text-right tabular-nums"
                      />
                      <select
                        value={draft.currency}
                        onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
                        aria-label="Валюта траты"
                        className="rounded-lg border border-zinc-200 px-2 py-1 text-xs"
                      >
                        {CURRENCIES.map((code) => (
                          <option key={code} value={code}>
                            {code}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={draft.comment}
                        onChange={(e) => setDraft({ ...draft, comment: e.target.value })}
                        aria-label="Комментарий"
                        className="min-w-[140px] flex-1 rounded-lg border border-zinc-200 px-2 py-1 text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => void saveEdit(item.id)}
                        className="rounded-lg bg-zinc-900 px-2.5 py-1 text-xs text-white"
                      >
                        Сохранить
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(null);
                          setDraft(null);
                        }}
                        className="text-xs text-zinc-400 hover:text-zinc-600"
                      >
                        Отмена
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={item.id} className="border-t border-zinc-100">
                  <td className="py-1.5 tabular-nums text-zinc-500">{item.occurred_on}</td>
                  <td className="py-1.5 text-right font-medium tabular-nums text-zinc-900">
                    {formatMoney(Number(item.amount), item.currency)}
                  </td>
                  <td className="py-1.5 pl-3 text-zinc-500">
                    <span className="line-clamp-2">{item.comment ?? '—'}</span>
                    <span className="text-[10px] text-zinc-400">
                      {item.payer}
                      {userId && item.created_by !== userId ? ' · запись другого пользователя' : ''}
                    </span>
                  </td>
                  <td className="py-1.5 pl-3 text-right">
                    <button
                      type="button"
                      onClick={() => startEdit(item)}
                      className="text-zinc-400 hover:text-zinc-700"
                    >
                      Изменить
                    </button>
                  </td>
                  <td className="py-1.5 pl-2 text-right">
                    {confirmDeleteId === item.id ? (
                      <span className="whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => void remove(item.id)}
                          className="text-red-600 hover:underline"
                        >
                          Удалить?
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="ml-2 text-zinc-400 hover:text-zinc-600"
                        >
                          нет
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(item.id)}
                        className="text-zinc-400 hover:text-red-600"
                      >
                        Удалить
                      </button>
                    )}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
