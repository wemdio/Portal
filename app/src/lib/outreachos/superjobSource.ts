/**
 * Источник «SuperJob» для OutreachOS-пайплайна (второй агрегатор рядом с HH).
 *
 * Собирает вакансии за окно window_hours по выбранным каталогам (профобластям
 * SJ — у них нет отрасли работодателя, как у HH), достаёт карточки клиентов
 * (/clients/{id}) и отдаёт работодателей в той же форме HhEmployer, чтобы
 * воронка (excludeB2c → suppression → конструктор → LLM → seen-дедуп) работала
 * без изменений.
 *
 * Отличия/капчи, учтённые в коде:
 * - count у /vacancies капнут до 40 (просим 100 — молча отдают 40, проба 06.08);
 * - id в seen-журнале префиксованный 'sj_<clientId>', чтобы не пересекаться с
 *   числовыми HH id;
 * - источник fail-open: любая ошибка сети/API — предупреждение в лог и пропуск,
 *   HH-часть прогона не должна страдать от падения SuperJob;
 * - сайт компании — client.url; у части клиентов там джоб-агрегатор/глобальный
 *   домен материнской компании — это режут downstream-фильтры (excludeB2c/LLM),
 *   здесь не выдумываем.
 */

import type { HhEmployer } from '@/lib/jobs/hhAutoParser';

const SJ_API = 'https://api.superjob.ru/2.0';
/** SJ молча капит count до 40. */
const PAGE_SIZE = 40;
/** Потолок страниц на каталог (SJ отдаёт максимум ~500 на выдачу). */
const MAX_PAGES_PER_CATALOGUE = 13;
const CLIENTS_CONCURRENCY = 5;

export interface SuperjobSourceOptions {
  apiKey: string;
  windowHours: number;
  catalogues: number[];
  /** Глобальный потолок вакансий на прогон (защита бюджета). */
  vacancyBudget: number;
  log: (msg: string) => void;
}

interface SjVacancy {
  id_client?: number;
  profession?: string;
}

interface SjClient {
  id?: number;
  title?: string;
  url?: string;
  description?: string;
  town?: { title?: string };
  industry?: Array<{ title?: string }>;
}

async function sjGet<T>(path: string, apiKey: string, tries = 3): Promise<T | null> {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const res = await fetch(`${SJ_API}${path}`, {
        headers: { 'X-Api-App-Id': apiKey },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        // 403/430 — ключ/лимит: смысл залогировать и выйти, ретраи не помогут.
        if (res.status === 403 || res.status === 430) {
          throw new Error(`SuperJob HTTP ${res.status}`);
        }
        throw new Error(`HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (attempt === tries) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  return null;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function fetchSuperjobEmployers(
  opts: SuperjobSourceOptions,
): Promise<HhEmployer[]> {
  const { apiKey, windowHours, catalogues, vacancyBudget, log } = opts;
  const from = Math.floor(Date.now() / 1000) - windowHours * 3600;

  // 1. Вакансии → уникальные клиенты (+ первая профессия как контекст).
  const clients = new Map<number, { vacancyTitle: string; catalogue: number }>();
  let scanned = 0;
  for (const cat of catalogues) {
    for (let page = 0; page < MAX_PAGES_PER_CATALOGUE; page += 1) {
      if (scanned >= vacancyBudget) break;
      const data = await sjGet<{ objects?: SjVacancy[]; more?: boolean }>(
        `/vacancies/?count=${PAGE_SIZE}&page=${page}&catalogues=${cat}&date_published_from=${from}`,
        apiKey,
      );
      const objs = data?.objects ?? [];
      scanned += objs.length;
      for (const v of objs) {
        if (v.id_client && !clients.has(v.id_client)) {
          clients.set(v.id_client, {
            vacancyTitle: v.profession ?? '',
            catalogue: cat,
          });
        }
      }
      if (objs.length < PAGE_SIZE || data?.more === false) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (scanned >= vacancyBudget) break;
  }
  log(`[superjob] вакансий просмотрено: ${scanned}, уникальных клиентов: ${clients.size}`);

  // 2. Карточки клиентов (сайт, описание, город).
  const ids = [...clients.keys()];
  const out: HhEmployer[] = [];
  let cursor = 0;
  let failed = 0;

  async function worker(): Promise<void> {
    while (cursor < ids.length) {
      const id = ids[cursor];
      cursor += 1;
      try {
        const c = await sjGet<SjClient>(`/clients/${id}/`, apiKey, 2);
        if (!c?.title) {
          failed += 1;
          continue;
        }
        const meta = clients.get(id)!;
        const description = c.description ? stripHtml(c.description).slice(0, 400) : undefined;
        out.push({
          id: `sj_${id}`,
          name: c.title,
          siteUrl: c.url?.trim() || null,
          hhUrl: `https://www.superjob.ru/clients/${id}`,
          area: c.town?.title ?? null,
          industries: [`superjob:${meta.catalogue}`],
          employeeCount: null,
          vacancyTitle: meta.vacancyTitle || undefined,
          description: description || undefined,
        });
      } catch {
        failed += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CLIENTS_CONCURRENCY, ids.length) }, () => worker()));

  log(`[superjob] карточки клиентов: ${out.length} ок, ${failed} ошибок`);
  return out;
}
