/**
 * Можно ли передать этот диалог — и если нет, то почему.
 *
 * Правило одно: на диалог приходится одна передача, живая или уже ушедшая.
 * Человек либо клиент, либо кандидат в партнёры; отправить его обоим — значит
 * посадить двух менеджеров на один контакт и получить два разных разговора с
 * ним же. То же и с повтором того же вида: сообщение уже у адресата, отозвать
 * его нельзя, и второй экземпляр — просто шум в чате.
 *
 * Упавшая передача не блокирует ничего: до адресата она не дошла, и повторить
 * её — единственный способ довести дело до конца.
 */

export type ForwardKind = 'lead' | 'partner';

export interface ExistingForward {
  kind: string;
  status: string;
  requested_at?: string | null;
  sent_at?: string | null;
}

const KIND_LABEL: Record<string, string> = {
  lead: 'лид',
  partner: 'кандидат в партнёры',
};

function label(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/**
 * Возвращает текст отказа или null, если передавать можно.
 *
 * Текст пишем сразу человеческим: он уходит прямо в интерфейс оператору, и
 * «conflict» вместо «этого человека уже передали как лида» ему не поможет.
 */
export function checkForwardConflict(
  existing: ExistingForward[],
  kind: ForwardKind,
): string | null {
  const blocking = existing.filter((f) => f.status === 'pending' || f.status === 'sent');
  if (blocking.length === 0) return null;

  // Ожидающая важнее ушедшей: про неё оператор может не знать вовсе, а отменить
  // её ещё можно — в отличие от уже отправленной.
  const pending = blocking.find((f) => f.status === 'pending');
  if (pending) {
    return pending.kind === kind
      ? `Эта передача уже стоит в очереди и ждёт отправки (${label(kind)})`
      : `Этот диалог уже стоит в очереди на передачу как «${label(pending.kind)}». `
        + 'Сначала дождитесь отправки или удалите задачу.';
  }

  const sent = blocking[0];
  return sent.kind === kind
    ? `Этот диалог уже передан как «${label(sent.kind)}» — повторная отправка только задвоит сообщение у адресата`
    : `Этот диалог уже передан как «${label(sent.kind)}», передать его ещё и как «${label(kind)}» нельзя: `
      + 'иначе на одном контакте окажутся два менеджера.';
}
