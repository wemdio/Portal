/**
 * Полная карточка вакансии и сайт работодателя из api.hh.ru.
 *
 * Поисковая выдача и наш кэш не заменяют повторную загрузку карточки перед
 * выпуском: вакансия могла закрыться или измениться (SOURCE_CONNECTORS §3).
 * hh с 15.04.2026 отвечает 403 без OAuth-токена и с зарубежных IP — поэтому
 * только через fetchWithRetry (HH_ACCESS_TOKEN + RU-прокси PROXY_URLS).
 */

import { fetchWithRetry, HHApiError } from '@/lib/parsers/hhParser';
import { htmlToText } from '../evidence';

const HH_API = 'https://api.hh.ru';

export interface HhVacancyCard {
  id: string;
  title: string;
  descriptionText: string;
  archived: boolean;
  publishedAt: string | null;
  url: string;
  employerId: string | null;
  employerName: string | null;
  areaName: string | null;
}

export type HhCardResult = { ok: true; card: HhVacancyCard } | { ok: false; reason: 'closed' | 'error'; detail: string };

interface RawVacancy {
  id?: string | number;
  name?: string;
  description?: string;
  archived?: boolean;
  published_at?: string;
  alternate_url?: string;
  area?: { name?: string };
  employer?: { id?: string | number; name?: string };
}

export async function fetchVacancyCard(vacancyId: string): Promise<HhCardResult> {
  try {
    const raw = await fetchWithRetry<RawVacancy>(`${HH_API}/vacancies/${encodeURIComponent(vacancyId)}`, {
      maxRetries: 2,
      timeoutMs: 20_000,
    });
    return {
      ok: true,
      card: {
        id: String(raw.id ?? vacancyId),
        title: String(raw.name ?? '').trim(),
        descriptionText: htmlToText(String(raw.description ?? '')),
        archived: raw.archived === true,
        publishedAt: raw.published_at ?? null,
        url: raw.alternate_url ?? `https://hh.ru/vacancy/${vacancyId}`,
        employerId: raw.employer?.id != null ? String(raw.employer.id) : null,
        employerName: raw.employer?.name ?? null,
        areaName: raw.area?.name ?? null,
      },
    };
  } catch (err) {
    if (err instanceof HHApiError && (err.status === 404 || err.status === 410)) {
      return { ok: false, reason: 'closed', detail: `hh ${err.status}` };
    }
    return { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function fetchEmployerSite(employerId: string): Promise<string | null> {
  try {
    const raw = await fetchWithRetry<{ site_url?: string }>(`${HH_API}/employers/${encodeURIComponent(employerId)}`, {
      maxRetries: 1,
      timeoutMs: 15_000,
    });
    return raw.site_url?.trim() || null;
  } catch {
    return null;
  }
}
