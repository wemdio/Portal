/**
 * Приводит юзернейм к единственной форме: без «@», в нижнем регистре.
 *
 * В выгрузках встречается всё сразу — «@ivanov», «ivanov», «https://t.me/ivanov».
 * Приводим на входе, чтобы в базе не оказалось трёх записей на одного человека.
 *
 * Пригласительные ссылки вида `t.me/+AbCdEf` отбрасываем: это не юзернейм, а
 * приглашение в чат, писать по нему некому.
 */

/** Telegram: 5–32 символа, латиница, цифры и подчёркивание. */
const USERNAME_RE = /^[a-z0-9_]{5,32}$/;

export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  let value = raw.replace(/ /g, ' ').trim();
  if (!value) return null;

  const link = /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(.+)$/i.exec(value);
  if (link) value = link[1];

  value = value.split(/[/?#]/)[0];
  value = value.replace(/^@+/, '').trim().toLowerCase();

  if (!USERNAME_RE.test(value)) return null;
  return value;
}
