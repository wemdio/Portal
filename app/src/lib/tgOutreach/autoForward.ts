/**
 * Отметка об автоматической передаче контакта менеджеру.
 *
 * Положительный триггер в ответе модели пересылает переписку в чат менеджера и
 * ставит диалогу статус «Лид». Статус «Лид» точно так же ставит и оператор
 * руками — поэтому сам по себе он не отвечает на вопрос «контакт уже у
 * менеджера или ещё нет». Отвечают на него поля `auto_forward_*` диалога, а
 * этот модуль переводит их в то, что видит человек.
 *
 * Отдельно от `forwardConflict`: там очередь ручной передачи со своим правилом
 * «одна передача на диалог», здесь — факт о том, что уже произошло само.
 */

export interface AutoForwardFields {
  /** Когда пересылка реально ушла. NULL — не уходила. */
  auto_forwarded_at?: string | null;
  /** Куда ушла: снимок настройки на момент отправки. */
  auto_forward_chat?: string | null;
  /** Причина, если не ушла. */
  auto_forward_error?: string | null;
}

export type AutoForwardMark =
  | { state: 'sent'; chat: string | null; at: string }
  | { state: 'failed'; chat: string | null; reason: string };

/**
 * Что показать в карточке диалога, или null — если автопересылки не было.
 *
 * Успех важнее ошибки: пересылка могла упасть и уйти со второй попытки, и тогда
 * старая причина сбоя — история, а не текущее состояние.
 */
export function describeAutoForward(fields: AutoForwardFields): AutoForwardMark | null {
  const chat = fields.auto_forward_chat ?? null;

  if (fields.auto_forwarded_at) {
    return { state: 'sent', chat, at: fields.auto_forwarded_at };
  }

  if (fields.auto_forward_error) {
    return { state: 'failed', chat, reason: fields.auto_forward_error };
  }

  return null;
}

/**
 * Предупреждение перед ручной передачей того же контакта.
 *
 * Кнопки «Передать лида/партнёра» намеренно остаются рабочими: автопересылка
 * отправляет голую переписку, без карточки «кто это, из какой базы пришёл, каким
 * аккаунтом вели», и досылать менеджеру контекст иногда нужно. Но решение
 * принимает оператор, а не интерфейс, — поэтому он должен знать, что контакт
 * уже у адресата.
 *
 * Упавшая автопересылка до менеджера не дошла, задваивать нечего — молчим.
 *
 * @param when Время отправки, уже отформатированное вызывающей стороной.
 */
export function autoForwardWarning(fields: AutoForwardFields, when?: string | null): string | null {
  if (!fields.auto_forwarded_at) return null;

  const where = fields.auto_forward_chat ? ` в ${fields.auto_forward_chat}` : '';
  const at = when ? ` (${when})` : '';

  return `Этот контакт уже ушёл менеджеру автоматически${where}${at}, по положительному триггеру.\n`
    + 'Повторная передача задвоит его у адресата.';
}
