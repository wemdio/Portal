'use client';

import { useCallback, useEffect, useState } from 'react';

import VendorSelect from '@/components/expenses/VendorSelect';
import { expensesFetch, formatMoney, formatRub, pluralOps } from '@/lib/expenses/client';
import { sourceLabel } from '@/lib/expenses/labels';
import type { ExpenseRow, VendorOption } from '@/lib/expenses/types';

interface QueueResponse {
  items: ExpenseRow[];
  total: number;
}

interface RulePayload {
  matchField: 'payee_name' | 'payee_inn' | 'purpose' | 'merchant';
  matchType: 'exact' | 'contains';
  pattern: string;
  source: null;
}

/**
 * Из чего лепится правило «и все будущие такие же».
 *
 * ИНН — точное совпадение: это идентификатор, не текст. Получатель —
 * `contains`, потому что банки дописывают к названию кавычки, ИП и
 * организационную форму. `merchant` и `payee_name` в SQL смотрят в одно и то
 * же поле витрины (см. apply_expense_rules), но имя поля попадает в правило и
 * читается человеком, поэтому у Brocard пишем `merchant`.
 *
 * `null` — запоминать нечего: сервер требует минимум три значащих символа,
 * иначе `contains`-образец совпал бы почти со всем.
 */
export function deriveRule(row: ExpenseRow): RulePayload | null {
  const inn = row.counterparty_inn?.trim() ?? '';
  if (inn.length >= 3) {
    return { matchField: 'payee_inn', matchType: 'exact', pattern: inn, source: null };
  }
  const name = row.counterparty?.trim() ?? '';
  if (name.length >= 3) {
    return {
      matchField: row.source === 'brocard' ? 'merchant' : 'payee_name',
      matchType: 'contains',
      pattern: name,
      source: null,
    };
  }
  return null;
}

export default function ClassifyQueue({
  queueQuery,
  vendors,
  onVendorCreated,
  onDone,
}: {
  /** from/to/source. Фильтр по категории здесь неприменим: у неразмеченного категории нет. */
  queueQuery: string;
  vendors: VendorOption[];
  onVendorCreated: (vendor: VendorOption) => void;
  onDone: () => void;
}) {
  const [items, setItems] = useState<ExpenseRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // Правило закрывает не только текущую операцию, поэтому после разметки с
  // галкой очередь перечитывается целиком, а не правится локально.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    void (async () => {
      setLoading(true);
      try {
        const res = await expensesFetch<QueueResponse>(`/unclassified?${queueQuery}`, {
          signal: controller.signal,
        });
        if (!active) return;
        setItems(res.items);
        setTotal(res.total);
        setError(null);
      } catch (e) {
        if (!active) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : 'Не удалось загрузить очередь');
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [queueQuery, reloadKey]);

  const classify = useCallback(
    async (row: ExpenseRow, vendorId: string, remember: boolean) => {
      const key = `${row.source}:${row.source_ref}`;
      const rule = remember ? deriveRule(row) : null;
      setBusyKey(key);
      setError(null);
      setNotice(null);
      try {
        const res = await expensesFetch<{ ok: boolean; applied?: number }>('/classify', {
          method: 'POST',
          body: JSON.stringify({
            source: row.source,
            sourceRef: row.source_ref,
            vendorId,
            ...(rule ? { rule } : {}),
          }),
        });
        const applied = res.applied ?? 0;
        setItems((prev) => prev.filter((item) => `${item.source}:${item.source_ref}` !== key));
        setTotal((prev) => Math.max(0, prev - 1 - applied));
        if (applied > 0) {
          setNotice(`Правило применилось ещё к ${applied} ${applied === 1 ? 'операции' : 'операциям'}`);
          setReloadKey((prev) => prev + 1);
        }
        onDone();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Не удалось разметить операцию');
      } finally {
        setBusyKey(null);
      }
    },
    [onDone],
  );

  const shownTotal = items.reduce((acc, row) => acc + (row.amount_rub ?? 0), 0);

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-3">
      <h3 className="text-sm font-semibold text-zinc-900">Очередь разметки</h3>
      <p className="mt-0.5 text-xs text-zinc-600">
        {total > 0
          ? `${pluralOps(total)} без вендора. Сверху самые крупные — они закрывают больше суммы.`
          : 'Операций без вендора нет.'}
        {items.length > 0 && items.length < total ? ` Показаны первые ${items.length}.` : ''}
      </p>
      {items.length > 0 ? (
        <p className="mt-0.5 text-[11px] text-zinc-500">
          Показанные операции — на {formatRub(shownTotal)} ₽.
        </p>
      ) : null}

      {error ? <div className="mt-2 text-xs text-red-600">{error}</div> : null}
      {notice ? <div className="mt-2 text-xs text-emerald-700">{notice}</div> : null}
      {loading ? <div className="mt-2 text-xs text-zinc-500">Загружаю…</div> : null}

      <div className="mt-2 space-y-2">
        {items.map((row) => (
          <QueueRow
            key={`${row.source}:${row.source_ref}`}
            row={row}
            vendors={vendors}
            onVendorCreated={onVendorCreated}
            busy={busyKey === `${row.source}:${row.source_ref}`}
            onClassify={classify}
          />
        ))}
        {!loading && items.length === 0 ? (
          <div className="text-xs text-zinc-500">Всё размечено.</div>
        ) : null}
      </div>
    </div>
  );
}

function QueueRow({
  row,
  vendors,
  onVendorCreated,
  busy,
  onClassify,
}: {
  row: ExpenseRow;
  vendors: VendorOption[];
  onVendorCreated: (vendor: VendorOption) => void;
  busy: boolean;
  onClassify: (row: ExpenseRow, vendorId: string, remember: boolean) => Promise<void>;
}) {
  const [vendorId, setVendorId] = useState('');
  const [remember, setRemember] = useState(true);

  const rule = deriveRule(row);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-zinc-700">
        <span className="tabular-nums text-zinc-500">{row.occurred_on_msk}</span>
        <span className="text-zinc-400">{sourceLabel(row.source)}</span>
        <span className="font-medium">{row.counterparty ?? 'получатель не указан'}</span>
        {row.counterparty_inn ? <span className="text-zinc-400">ИНН {row.counterparty_inn}</span> : null}
        <span className="ml-auto shrink-0 font-semibold tabular-nums">
          {row.amount_rub === null ? (
            <span className="text-amber-700">{formatMoney(row.amount, row.currency)} · курса ЦБ нет</span>
          ) : (
            `${formatRub(row.amount_rub)} ₽`
          )}
        </span>
      </div>
      {row.details ? <div className="mt-1 text-[11px] text-zinc-500">{row.details}</div> : null}

      <div className="mt-2 flex flex-wrap items-start gap-2">
        {/* Ширину задаёт обёртка: само поле — блок на 100%, и во flex-строке
            без ограничения оно схлопнулось бы по содержимому. */}
        <div className="w-full max-w-[16rem]">
          <VendorSelect
            value={vendorId}
            onChange={setVendorId}
            options={vendors}
            onCreated={onVendorCreated}
          />
        </div>

        <label className="flex items-center gap-1.5 text-xs text-zinc-600">
          <input
            type="checkbox"
            checked={remember && rule !== null}
            disabled={rule === null}
            onChange={(e) => setRemember(e.target.checked)}
          />
          Запомнить правило
        </label>

        <button
          type="button"
          disabled={!vendorId || busy}
          onClick={() => void onClassify(row, vendorId, remember && rule !== null)}
          className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs text-white disabled:opacity-40"
        >
          {busy ? 'Сохраняю…' : 'Разметить'}
        </button>
      </div>

      <p className="mt-1 text-[11px] text-zinc-400">
        {rule === null
          ? 'Запоминать нечего: у операции нет ни ИНН, ни получателя длиннее двух символов.'
          : rule.matchType === 'exact'
            ? `Правило: ИНН ровно «${rule.pattern}» — и все будущие такие же.`
            : `Правило: получатель содержит «${rule.pattern}» — и все будущие такие же.`}
      </p>
    </div>
  );
}
