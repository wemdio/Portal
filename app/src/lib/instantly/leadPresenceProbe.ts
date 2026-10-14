import 'server-only';

/**
 * Замер: лежит ли адрес уже в воркспейсе рассыльщика и, если лежит, в ЧЬЕЙ
 * кампании.
 *
 * Зачем нужен отдельный модуль. Загрузка лидов умеет флаг
 * `skip_if_in_campaign`, и у Instantly он, вопреки имени, работает НА ВЕСЬ
 * ВОРКСПЕЙС: лид отсеивается, если он есть в ЛЮБОЙ кампании аккаунта, включая
 * кампании других клиентов студии (см. докблок
 * `AppendLeadsToClientCampaignInput.skipIfInCampaign` в
 * `lib/clientLaunch/appendLeads.ts` — это ЕДИНСТВЕННОЕ наше свидетельство о
 * семантике флага, снаружи её подтвердить нечем). Ответ загрузки говорит
 * только «столько-то не взяли» и не делит отсев на «этот адрес уже наш» и
 * «этот адрес занят соседом». Разделить может только отдельное чтение — оно
 * здесь.
 *
 * ПРИНЦИП: модуль ТОЛЬКО СЧИТАЕТ. Он ничего не фильтрует и не решает, поэтому
 * ни один его исход не может потерять контакт. Когда флаг когда-нибудь
 * переведут в `false`, дедуп против СВОИХ кампаний придётся делать самим — и
 * вот тогда «не знаю» обязано будет читаться как «не отправлять» (fail-closed).
 * Пока флаг `true`, «не знаю» стоит ровно одну строку в отчёте.
 *
 * ЦЕНА. Один запрос на адрес, БЕЗ пагинации: бюджет запросов задаёт
 * вызывающий, и всё, что не решилось с первой страницы, честно помечается
 * `undecided`. Лимитер Instantly общий на воркспейс (~10–15 RPM,
 * `lib/instantly/rateLimiter.ts`), то есть каждый запрос замера — это запрос,
 * которого в ту минуту не сделает другой контур. Поэтому бюджет обязан быть
 * маленьким, а выборка — выборкой, а не всей пачкой.
 *
 * ЧЕСТНОСТЬ ОТВЕТА. Положительный вывод («адрес в нашей кампании») делается по
 * одной найденной строке — этого достаточно. Любой ОТРИЦАТЕЛЬНЫЙ вывод («в
 * нашей кампании его нет», «в воркспейсе его нет») делается только когда
 * страница дочитана до конца: есть курсор продолжения или страница пришла
 * полной — вывод не делается, ставится `undecided`. Отсюда же бесплатная
 * проверка самого фильтра: если провайдер игнорирует `contacts`, он вернёт
 * полную страницу произвольных лидов с курсором, и замер даст `undecided`
 * почти на всех адресах — то есть скажет «этим способом померить нельзя»
 * вместо того, чтобы выдать ноль за измерение.
 */

import { listLeads } from './client';
import type { InstantlyRequestOptions } from './accounts';

/** Страница чтения. Совпадает с постраничностью остальных чтений лидов. */
const PAGE_SIZE = 100;

/**
 * Исход по одному адресу. Состояний пять, и ни одно не сворачивается в другое:
 * «мы не знаем» — это НЕ «в воркспейсе нет», а «есть, но без кампании» — это НЕ
 * «есть в чужой кампании» (у списка и у кампании разные флаги отсева).
 */
export type HeLeadPresence =
  /** Адрес уже в кампании, которую назвал вызывающий. */
  | 'own_campaign'
  /** Адрес в воркспейсе и привязан к ДРУГОЙ кампании. */
  | 'other_campaign'
  /** Адрес в воркспейсе, но ни в одной кампании (список, импорт). */
  | 'no_campaign'
  /** Адреса в воркспейсе нет — доказано дочитанной страницей. */
  | 'absent'
  /** Вывода нет: страница не дочитана, ответ не разобран или отказ транспорта. */
  | 'undecided';

export type HeLeadPresenceCounts = Record<HeLeadPresence, number>;

export interface HeLeadPresenceProbe {
  counts: HeLeadPresenceCounts;
  /** Сколько РАЗНЫХ адресов реально спросили (после нормализации и дедупа). */
  probed: number;
  /** Сколько запросов к провайдеру это стоило. */
  requests: number;
  /**
   * Остались ли неспрошенные адреса: кончился бюджет запросов, вышел срок или
   * отказал транспорт.
   */
  stoppedEarly: boolean;
}

function emptyCounts(): HeLeadPresenceCounts {
  return { own_campaign: 0, other_campaign: 0, no_campaign: 0, absent: 0, undecided: 0 };
}

/** Кампания лида: API v2 пишет `campaign`, наш клиент сохраняет алиас `campaign_id`. */
function leadCampaignId(lead: { campaign?: string | null; campaign_id?: string | null }): string {
  if (typeof lead.campaign === 'string' && lead.campaign.trim()) return lead.campaign.trim();
  if (typeof lead.campaign_id === 'string' && lead.campaign_id.trim()) return lead.campaign_id.trim();
  return '';
}

/**
 * Разбор ОДНОЙ страницы ответа под один адрес. Вынесен отдельно, чтобы правило
 * «отрицательный вывод только по дочитанной странице» стояло в одном месте.
 */
function readPresence(
  page: Awaited<ReturnType<typeof listLeads>>,
  email: string,
  ownCampaignId: string,
): HeLeadPresence {
  const items = Array.isArray(page?.items) ? page.items : null;
  // Страница длиннее запрошенной — ответ не тот, за который себя выдаёт.
  if (!items || items.length > PAGE_SIZE) return 'undecided';

  let other = false;
  let orphan = false;
  for (const lead of items) {
    if (!lead || typeof lead.email !== 'string') continue;
    if (lead.email.trim().toLowerCase() !== email) continue;
    const campaign = leadCampaignId(lead);
    // Положительное доказательство: одной строки хватает, остаток страницы и
    // следующие страницы ничего не отменят.
    if (campaign === ownCampaignId) return 'own_campaign';
    if (campaign) other = true;
    else orphan = true;
  }

  const cursor = page.next_starting_after;
  const hasMore = typeof cursor === 'string' && cursor.trim().length > 0;
  // Полная страница без курсора — тоже «не дочитали»: у ответа кончилось место,
  // а продолжения он не дал.
  if (hasMore || items.length >= PAGE_SIZE) return 'undecided';

  if (other) return 'other_campaign';
  if (orphan) return 'no_campaign';
  return 'absent';
}

/**
 * Спрашивает провайдера про каждый адрес по одному разу, пока не кончится
 * бюджет запросов. Никогда не бросает: отказ транспорта — это не ответ о лиде,
 * он останавливает замер целиком (следующие запросы упрутся в то же самое и
 * сожгут бюджет на ошибках) и помечает адрес `undecided`.
 */
export async function probeLeadPresence(input: {
  emails: readonly string[];
  /** Наша кампания — по ней исход делится на «уже наш» и «занят соседом». */
  ownCampaignId: string;
  /** Потолок запросов к провайдеру на весь вызов. ≤ 0 — замер не делается. */
  requestBudget: number;
  /**
   * Срок на ВЕСЬ замер. Нужен отдельно от числа запросов: медленный провайдер
   * растягивает N запросов на сколько угодно, а замер обязан уступать дорогу
   * работе, ради которой ночь и затеяна. ≤ 0 или нет ключа — срока нет.
   */
  budgetMs?: number;
  requestOptions?: InstantlyRequestOptions;
  /** Признак жизни для сторожа простоя вызывающего — на каждый ответ. */
  onRequest?: () => void;
  /**
   * Работу прервали. Замер обязан замолчать первым: отменённая джоба не должна
   * доедать общий лимит воркспейса ради числа, которое уже никто не прочитает.
   */
  shouldStop?: () => boolean;
}): Promise<HeLeadPresenceProbe> {
  const counts = emptyCounts();
  const probe: HeLeadPresenceProbe = { counts, probed: 0, requests: 0, stoppedEarly: false };

  const ownCampaignId = input.ownCampaignId.trim();
  const budget = Number.isFinite(input.requestBudget) ? Math.floor(input.requestBudget) : 0;

  const queue: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.emails) {
    const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!email || seen.has(email)) continue;
    seen.add(email);
    queue.push(email);
  }
  if (!ownCampaignId || budget <= 0) {
    probe.stoppedEarly = queue.length > 0;
    return probe;
  }

  const deadline =
    typeof input.budgetMs === 'number' && Number.isFinite(input.budgetMs) && input.budgetMs > 0
      ? Date.now() + input.budgetMs
      : null;

  for (const email of queue) {
    if (
      probe.requests >= budget
      || (deadline !== null && Date.now() >= deadline)
      || input.shouldStop?.() === true
    ) {
      probe.stoppedEarly = true;
      break;
    }
    probe.requests += 1;
    let page: Awaited<ReturnType<typeof listLeads>> | null = null;
    try {
      page = await listLeads({ contacts: [email], limit: PAGE_SIZE }, input.requestOptions);
    } catch {
      page = null;
    }
    // Признак жизни даёт и неудачный запрос: время на него ушло реальное.
    input.onRequest?.();
    probe.probed += 1;
    if (!page) {
      counts.undecided += 1;
      probe.stoppedEarly = true;
      break;
    }
    counts[readPresence(page, email, ownCampaignId)] += 1;
  }

  return probe;
}
