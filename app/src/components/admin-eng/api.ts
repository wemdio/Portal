'use client';

/**
 * Раздел «Английские клиенты»: запросы экрана к API админки (Bearer-токен
 * сессии, повтор после обновления сессии — authFetch). Ошибка ответа —
 * Error с текстом `error` из тела (роуты пишут его по-русски).
 */

import { authFetch } from '@/lib/authFetch';
import type { HeEngAdminCard, HeEngAdminList } from '@/lib/hypothesisEngine/engAdminView';
import type { HeEngBlockLine, HeEngBlockReport, HeEngUnblockReport } from '@/lib/hypothesisEngine/engAccountBlockMarker';
import type { EngSendingPostResult } from './labels';

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(url, init);
  const body = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null;
  if (!res.ok || body === null) {
    const msg = body && typeof body.error === 'string' && body.error ? body.error : `Ошибка ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

/** Карточка: модель чтения + строки отчёта последней блокировки (их пишет engAccountBlock). */
export type EngClientCardResponse = HeEngAdminCard & { last_stop_lines: HeEngBlockLine[] | null };

/** Отчёт блокировки или разблокировки в ответе роута блокировки (строки пишет engAccountBlock). */
export interface EngStopBox {
  complete: boolean;
  error?: string;
  lines: HeEngBlockLine[];
  report: HeEngBlockReport | HeEngUnblockReport;
}

/**
 * Ответ POST /api/admin/users/[id]/block для клиента английского кабинета:
 * блокировка — 200 с `eng_stop`; разблокировка — 200 с `eng_unblock` (если
 * остановка перед снятием бана не подтвердилась или по ходу нажали
 * «Заблокировать» — `blocked: true`, бан на месте или поставлен снова), а если
 * бан не снялся — 500 с `error` и тем же `eng_unblock`.
 */
export interface EngBlockResponse {
  ok?: true;
  blocked?: boolean;
  bannedUntil?: string | null;
  error?: string;
  eng_stop?: EngStopBox;
  eng_unblock?: EngStopBox;
}

export function fetchEngClients(params: { page: number; filter: string; q: string }): Promise<HeEngAdminList> {
  const qs = new URLSearchParams();
  qs.set('page', String(params.page));
  if (params.filter && params.filter !== 'all') qs.set('filter', params.filter);
  if (params.q.trim()) qs.set('q', params.q.trim());
  return call<HeEngAdminList>(`/api/admin/eng-clients?${qs.toString()}`);
}

export function fetchEngClientCard(id: string, refresh: boolean): Promise<EngClientCardResponse> {
  return call<EngClientCardResponse>(`/api/admin/eng-clients/${id}${refresh ? '?refresh=1' : ''}`);
}

export function postEngSending(id: string, enabled: boolean): Promise<EngSendingPostResult> {
  return call<EngSendingPostResult>(`/api/admin/users/${id}/eng-sending`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
}

/**
 * Блокировка / разблокировка. Отчёт приходит и с ошибкой (500 разблокировки) —
 * поэтому тело отдаётся вместе со статусом; бросает только на ответе без тела.
 */
export async function postEngBlock(id: string, blocked: boolean): Promise<{ status: number; body: EngBlockResponse }> {
  const res = await authFetch(`/api/admin/users/${id}/block`, {
    method: 'POST',
    body: JSON.stringify({ blocked }),
  });
  const body = (await res.json().catch(() => null)) as EngBlockResponse | null;
  if (body === null) throw new Error(`Ошибка ${res.status}`);
  return { status: res.status, body };
}

export function postEngPassword(id: string, password: string): Promise<{ ok: true }> {
  return call<{ ok: true }>(`/api/admin/users/${id}/password`, {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export function deleteEngAccount(id: string): Promise<{ ok: true }> {
  return call<{ ok: true }>(`/api/admin/users/${id}`, { method: 'DELETE' });
}
