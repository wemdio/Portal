/**
 * Из какой базы («гипотезы») пришёл собеседник.
 *
 * Зачем. На вкладке «Диалоги» человек — это ник и переписка, и всё. Понять,
 * какой гипотезой его зацепили, можно было только уходя на вкладку «Базы» и
 * выгружая каждую базу по очереди, — а разметку диалогов ведут подряд, десятками.
 *
 * Прямой ссылки «диалог → база» в модели нет: диалог заводится по входящему из
 * Telegram и знает только собеседника. Сверяем по тем же двум ключам, что и
 * остальной аутрич: юзернейм (`usernameKey`, как в отчёте и `baseStats`) и
 * `tg_user_id`, который база запоминает в момент отправки первого сообщения.
 *
 * Один ник может лежать в двух гипотезах сразу — базы собирают из пересекающихся
 * чатов, и дедупликация в портале только внутри базы (`unique (base_id, username)`).
 * Тогда показываем ту, из которой человеку РЕАЛЬНО написали (есть `sent_at`, и
 * если их несколько — последнюю), а остальные отдаём отдельным списком: соврать
 * «он из Гипотезы 1», когда писала Гипотеза 2, хуже, чем не сказать ничего.
 */
import { usernameKey } from './report';

export interface DialogBaseRef {
  id: string;
  name: string;
}

export interface DialogBaseContact {
  base_id: string;
  username: string | null;
  tg_user_id: number | null;
  sent_at: string | null;
}

export interface DialogBaseMatch {
  id: string;
  name: string;
  /** Другие базы кампании с тем же контактом. Пусто — контакт уникален. */
  alsoIn: string[];
}

interface Candidate {
  baseId: string;
  sentAtMs: number | null;
}

function push(map: Map<string, Candidate[]>, key: string, value: Candidate): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Отправившая база впереди, среди отправивших — последняя по времени. Остальное
 * упорядочиваем по id, чтобы одинаковые данные всегда давали одинаковый ответ:
 * бейдж, который на каждой перезагрузке называет другую гипотезу, хуже пустого.
 */
function rank(a: Candidate, b: Candidate): number {
  if ((a.sentAtMs === null) !== (b.sentAtMs === null)) return a.sentAtMs === null ? 1 : -1;
  if (a.sentAtMs !== null && b.sentAtMs !== null && a.sentAtMs !== b.sentAtMs) {
    return b.sentAtMs - a.sentAtMs;
  }
  return a.baseId < b.baseId ? -1 : a.baseId > b.baseId ? 1 : 0;
}

/**
 * Готовит поиск базы по диалогу. Индекс строится один раз на страницу списка:
 * запрос в базу на каждую строку — это тридцать запросов на экран.
 */
export function buildDialogBaseIndex(
  bases: DialogBaseRef[],
  contacts: DialogBaseContact[],
): (dialog: { tg_username?: string | null; tg_user_id?: number | null }) => DialogBaseMatch | null {
  const names = new Map(bases.map((b) => [b.id, b.name] as const));
  const byUsername = new Map<string, Candidate[]>();
  const byTgId = new Map<string, Candidate[]>();

  for (const c of contacts) {
    // Контакт чужой кампании в ответ попасть не должен, даже если его принесла
    // выборка: имя базы для него нам всё равно неизвестно.
    if (!names.has(c.base_id)) continue;
    const parsed = c.sent_at ? new Date(c.sent_at).getTime() : null;
    const candidate: Candidate = { baseId: c.base_id, sentAtMs: Number.isFinite(parsed) ? parsed : null };
    const key = usernameKey(c.username);
    if (key) push(byUsername, key, candidate);
    if (c.tg_user_id !== null && c.tg_user_id !== undefined) push(byTgId, String(c.tg_user_id), candidate);
  }

  return (dialog) => {
    const found: Candidate[] = [];
    const key = usernameKey(dialog.tg_username);
    if (key) found.push(...(byUsername.get(key) ?? []));
    if (dialog.tg_user_id !== null && dialog.tg_user_id !== undefined) {
      found.push(...(byTgId.get(String(dialog.tg_user_id)) ?? []));
    }
    if (!found.length) return null;

    found.sort(rank);
    const ordered: string[] = [];
    for (const c of found) if (!ordered.includes(c.baseId)) ordered.push(c.baseId);

    const [first, ...rest] = ordered;
    return {
      id: first,
      name: names.get(first) as string,
      alsoIn: rest.map((id) => names.get(id) as string),
    };
  };
}
