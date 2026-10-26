'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';

import { DealPicker, ProjectPicker, type PickedDeal, type PickedProject } from '@/components/expenses/LinkPickers';
import VendorSelect from '@/components/expenses/VendorSelect';
import { expensesFetch, mskToday } from '@/lib/expenses/client';
import { DEFAULT_PAYER } from '@/lib/expenses/labels';
import {
  MANUAL_INCOME_CHANNELS,
  type ManualEntry,
  type ProjectOption,
  type VendorOption,
} from '@/lib/expenses/types';

export type ManualKind = 'income' | 'expense';

const CURRENCIES = ['RUB', 'USD', 'EUR', 'KZT', 'CNY', 'GBP'];

const FIELD_CLASS =
  'w-full rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70';

const LABEL_CLASS = 'flex min-w-0 flex-col gap-1 text-[11px] text-zinc-500';

/**
 * Окно ручного дохода или расхода — и новой записи, и правки старой.
 *
 * Доход — деньги из источников, которые не синкаются (наличные, личная карта):
 * от кого, откуда (способ получения), за что и сколько. Расход — то, чего нет
 * в банковских выгрузках. Обе записи можно привязать к проекту портала и к
 * сделке AMO.
 */
export default function ManualEntryModal({
  kind,
  entry = null,
  onClose,
  onSaved,
}: {
  kind: ManualKind;
  /** Запись для правки; без неё — новая. */
  entry?: ManualEntry | null;
  onClose: () => void;
  onSaved: (saved: { occurredOn: string }) => void;
}) {
  const isIncome = kind === 'income';
  // Дата вычисляется один раз: вызов Date в теле рендера ловит react-hooks/purity.
  const [today] = useState(() => mskToday());

  const [occurredOn, setOccurredOn] = useState(entry?.occurred_on ?? today);
  const [amount, setAmount] = useState(entry ? String(entry.amount) : '');
  const [currency, setCurrency] = useState(entry?.currency ?? 'RUB');
  const [payer, setPayer] = useState(entry?.payer ?? (isIncome ? '' : DEFAULT_PAYER));
  const [channel, setChannel] = useState<string>(entry?.channel ?? MANUAL_INCOME_CHANNELS[0]);
  const [comment, setComment] = useState(entry?.comment ?? '');
  const [vendorId, setVendorId] = useState(entry?.vendor_id ?? '');
  const [project, setProject] = useState<PickedProject | null>(entry?.project ?? null);
  const [deal, setDeal] = useState<PickedDeal | null>(
    entry?.deal ? { amoId: entry.deal.amoId, name: entry.deal.name } : null,
  );

  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [directory, setDirectory] = useState<VendorOption[]>([]);
  const [createdVendors, setCreatedVendors] = useState<VendorOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Справочники — проекты всегда, вендоры только расходу. Сбой справочника не
  // мешает внести сумму: привязку можно поставить позже правкой.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const [projectsRes, vendorsRes] = await Promise.all([
          expensesFetch<{ items: ProjectOption[] }>('/links/projects', { signal: controller.signal }),
          isIncome
            ? Promise.resolve({ items: [] as VendorOption[] })
            : expensesFetch<{ items: VendorOption[] }>('/vendors/directory', { signal: controller.signal }),
        ]);
        setProjects(projectsRes.items);
        setDirectory(vendorsRes.items);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : 'Не удалось загрузить проекты');
      }
    })();
    return () => controller.abort();
  }, [isIncome]);

  // Esc закрывает окно; списки внутри гасят свой Esc сами.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, saving]);

  const vendors = useMemo(() => {
    const byId = new Map<string, VendorOption>();
    for (const item of directory) byId.set(item.id, item);
    for (const item of createdVendors) byId.set(item.id, item);
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [directory, createdVendors]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const common = {
        occurredOn,
        amount: Number(amount),
        currency,
        comment: comment.trim(),
        projectId: project?.id ?? null,
        amoDealId: deal?.amoId ?? null,
      };
      const body = isIncome
        ? { ...common, payer: payer.trim(), channel }
        : {
            ...common,
            payer: payer.trim() || undefined,
            // Вендор правкой трогаем, только если его поменяли: иначе разметка,
            // поставленная в очереди, переписалась бы на ручную без причины.
            ...(entry && vendorId === (entry.vendor_id ?? '') ? {} : { vendorId: vendorId || null }),
          };
      const path = isIncome ? '/incomes/manual' : '/manual';
      await expensesFetch(entry ? `${path}/${entry.id}` : path, {
        method: entry ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      onSaved({ occurredOn });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  }

  const title = `${entry ? 'Изменить' : 'Новый'} ${isIncome ? 'доход' : 'расход'}`;

  // Порталом в оболочку портала — по той же причине, что DealModal: список
  // ручных записей лежит в `.glass-panel` с backdrop-filter, и `fixed` внутри
  // него отсчитывался бы от панели, а не от окна. Оболочка, а не body, — чтобы
  // окно не выпало из-под правил тёмной темы.
  if (typeof document === 'undefined') return null;
  const host = document.querySelector('.portal-shell') ?? document.body;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-entry-title"
        className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
          <h2 id="manual-entry-title" className="text-sm font-semibold text-zinc-900">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Закрыть окно"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg px-1.5 text-lg leading-none text-zinc-400 hover:text-zinc-700"
          >
            ×
          </button>
        </div>

        <form onSubmit={submit} className="space-y-3 px-5 py-4">
          <div className="grid grid-cols-[1fr_1fr_88px] gap-2">
            <label className={LABEL_CLASS}>
              Дата
              <input
                type="date"
                value={occurredOn}
                max={today}
                onChange={(e) => setOccurredOn(e.target.value)}
                required
                className={FIELD_CLASS}
              />
            </label>
            <label className={LABEL_CLASS}>
              Сумма
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
                autoFocus
                className={`${FIELD_CLASS} text-right tabular-nums`}
              />
            </label>
            <label className={LABEL_CLASS}>
              Валюта
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} className={FIELD_CLASS}>
                {CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {isIncome ? (
            <div className="grid grid-cols-[1fr_160px] gap-2">
              <label className={LABEL_CLASS}>
                От кого
                <input
                  type="text"
                  value={payer}
                  onChange={(e) => setPayer(e.target.value)}
                  required
                  placeholder="Клиент или компания"
                  className={FIELD_CLASS}
                />
              </label>
              <label className={LABEL_CLASS}>
                Откуда
                <select value={channel} onChange={(e) => setChannel(e.target.value)} className={FIELD_CLASS}>
                  {MANUAL_INCOME_CHANNELS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {/* Обёртка, а не label: внутри VendorSelect свой input. */}
              <div className={LABEL_CLASS}>
                <span aria-hidden="true">Вендор</span>
                <VendorSelect
                  value={vendorId}
                  onChange={setVendorId}
                  options={vendors}
                  onCreated={(vendor) =>
                    setCreatedVendors((prev) => (prev.some((v) => v.id === vendor.id) ? prev : [...prev, vendor]))
                  }
                  emptyLabel="Без вендора"
                  emptyHint="уйдёт в очередь разметки"
                />
              </div>
              <label className={LABEL_CLASS}>
                Кто платил
                <input
                  type="text"
                  value={payer}
                  onChange={(e) => setPayer(e.target.value)}
                  placeholder={DEFAULT_PAYER}
                  className={FIELD_CLASS}
                />
              </label>
            </div>
          )}

          <label className={LABEL_CLASS}>
            {isIncome ? 'За что' : 'Комментарий'}
            <input
              type="text"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={isIncome ? 'Например, оплата за октябрь' : ''}
              className={FIELD_CLASS}
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <div className={LABEL_CLASS}>
              <span aria-hidden="true">Проект</span>
              <ProjectPicker value={project} onChange={setProject} options={projects} />
            </div>
            <div className={LABEL_CLASS}>
              <span aria-hidden="true">Сделка в AmoCRM</span>
              <DealPicker value={deal} onChange={setDeal} />
            </div>
          </div>

          {currency !== 'RUB' ? (
            <p className="text-[11px] text-zinc-400">Курс ЦБ подтянется ночью — до тех пор сумма не войдёт в рублёвый итог.</p>
          ) : null}

          {error ? <div className="text-xs text-red-600">{error}</div> : null}

          <div className="flex items-center justify-end gap-2 border-t border-zinc-100 pt-3">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-lg px-3 py-2 text-xs text-zinc-500 hover:text-zinc-800"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70 disabled:opacity-40"
            >
              {saving ? 'Сохраняю…' : entry ? 'Сохранить' : `Добавить ${isIncome ? 'доход' : 'расход'}`}
            </button>
          </div>
        </form>
      </div>
    </div>,
    host,
  );
}
