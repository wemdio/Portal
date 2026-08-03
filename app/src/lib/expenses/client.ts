'use client';

import { authFetch } from '@/lib/authFetch';

/**
 * Клиентский слой дашборда раздела «Деньги» — расходов и доходов.
 *
 * Все запросы идут сюда и только сюда: страница не ходит в Supabase напрямую,
 * потому что витрины `expenses_v` и `incomes_v` читает исключительно серверный
 * код под service_role (см. `lib/expenses/rows.ts`). Токен сессии подставляет
 * `authFetch` — он же умеет один раз обновить протухший access-token, чего
 * ручной `getSession()` не делает.
 */

const API_BASE = '/api/expenses';

/** Текст ошибки от роута. Роуты отвечают `{ error }` — показываем его как есть. */
async function errorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (body?.error) return body.error;
  if (res.status === 401) return 'Сессия истекла — перезайди в портал';
  // Расходной формулировки здесь быть не может: тот же фетчер обслуживает и
  // доходную вкладку, где «доступ к расходам» читался бы как чужая ошибка.
  if (res.status === 403) return 'Раздел «Деньги» недоступен';
  return `Ошибка ${res.status}`;
}

/** Запрос к `/api/expenses/*` с токеном текущей сессии. Бросает `Error` с текстом от роута. */
export async function expensesFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(`${API_BASE}${path}`, init);
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()) as T;
}

/**
 * Скачать файл из `/api/expenses/*`.
 *
 * Через `<a href>` не получится: экспорт закрыт тем же гардом, что и остальные
 * роуты, а браузер в обычную навигацию заголовок Authorization не положит —
 * пользователь получил бы 403 вместо файла. Поэтому тянем ответ фетчем и
 * отдаём его как blob.
 */
export async function expensesDownload(path: string, fallbackName: string): Promise<void> {
  const res = await authFetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(await errorText(res));

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filenameFromDisposition(res.headers.get('content-disposition')) ?? fallbackName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // Отзываем не сразу: Safari успевает начать скачивание только после тика.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const match = /filename="?([^";]+)"?/i.exec(header);
  return match?.[1] ?? null;
}

const RUB_FORMAT = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const AMOUNT_FORMAT = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

/** Рубли без копеек: на дашборде решают по порядку величины, копейки только мешают выравниванию. */
export function formatRub(value: number): string {
  return RUB_FORMAT.format(Math.round(value));
}

/** Сумма в исходной валюте — с копейками, потому что это конкретная строка выписки. */
export function formatMoney(value: number, currency: string): string {
  return `${AMOUNT_FORMAT.format(value)} ${currency}`;
}

export function formatDelta(delta: number | null): string {
  if (delta === null) return '—';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${Math.round(delta * 100)}%`;
}

/** «120 USD · 40 EUR» — суммы, для которых не нашёлся курс ЦБ. */
export function formatCurrencyMap(map: Record<string, number>): string {
  return Object.entries(map)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([currency, value]) => formatMoney(value, currency))
    .join(' · ');
}

/** Склонение для счётчиков операций: «1 операция», «2 операции», «5 операций». */
export function pluralOps(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} операция`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} операции`;
  return `${count} операций`;
}

/**
 * Сегодняшняя дата по Москве в формате YYYY-MM-DD.
 *
 * Ровно то же, что `todayMsk()` в `lib/expenses/request.ts`: витрина кладёт
 * траты в московский день, и если фронт возьмёт локальную дату браузера, то в
 * поясе восточнее Москвы форма ручной траты по вечерам будет отправлять
 * «завтрашнюю» дату и получать 400 «Дата траты в будущем».
 */
export function mskToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
}

/** Дата бакета/периода в человеческом виде: `2026-07-15` → `15.07.2026`. */
export function formatIsoDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${d}.${m}.${y}`;
}
