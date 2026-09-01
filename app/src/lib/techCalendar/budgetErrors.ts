export interface TechCalendarMutationError {
  status: number;
  code: string;
  message: string;
}

/**
 * Budget and concurrency errors are raised by database triggers/RPCs so every
 * write path observes the same hard limit. Translate their stable tokens at
 * the HTTP boundary instead of leaking Postgres messages to the interface.
 */
export function techCalendarMutationError(
  error: { message?: string } | null | undefined,
): TechCalendarMutationError | null {
  const message = error?.message ?? '';
  if (message.includes('payment_request_cost_limit_exceeded')) {
    return {
      status: 409,
      code: 'cost_limit_exceeded',
      message: 'Лимит костов 650 000 ₽ на этот месяц будет превышен.',
    };
  }
  if (message.includes('payment_request_cost_budget_incomplete')) {
    return {
      status: 409,
      code: 'cost_budget_incomplete',
      message: 'Не удалось пересчитать календарные расходы в рубли. Обновите курсы и повторите.',
    };
  }
  if (message.includes('tech_subscription_conflict')) {
    return {
      status: 409,
      code: 'tech_subscription_conflict',
      message: 'Карточка сервиса уже изменилась. Обновите страницу и повторите.',
    };
  }
  if (message.includes('tech_subscription_invalid_input')) {
    return {
      status: 409,
      code: 'tech_subscription_invalid_input',
      message: 'Продлить можно только подтверждённый сервис, дата списания которого уже наступила.',
    };
  }
  if (message.includes('tech_subscription_paid_cycle_locked')) {
    return {
      status: 409,
      code: 'tech_subscription_paid_cycle_locked',
      message: 'Оплаченный цикл уже зафиксирован. Для следующего периода используйте продление.',
    };
  }
  if (message.includes('tech_subscription_cycle_already_archived')) {
    return {
      status: 409,
      code: 'tech_subscription_cycle_already_archived',
      message: 'Этот цикл уже сохранён в истории оплат. Обновите страницу.',
    };
  }
  if (message.includes('tech_subscription_not_found')) {
    return {
      status: 404,
      code: 'tech_subscription_not_found',
      message: 'Сервис не найден.',
    };
  }
  return null;
}
