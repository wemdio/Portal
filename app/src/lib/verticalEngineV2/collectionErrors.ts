/** Browser-safe error classification. Never return provider bodies or database details to the UI. */
function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  return error instanceof Error ? error.message : '';
}

/** Billing needs an operator action, not another immediate attempt at the same paid operation. */
export function isVeProviderBillingError(error: unknown): boolean {
  const message = errorMessage(error);
  return /\b(?:Requesty|Serper)\s*(?:HTTP\s*)?[:(]?\s*402\b/i.test(message)
    || /\bSerper billing:/i.test(message)
    || (/\b(?:Requesty|Serper)\b/i.test(message)
      && /not enough credits|insufficient[\s_-]+(?:funds|balance|credits|search credits)|payment[\s_-]+required|credit balance (?:is )?too low/i.test(message));
}

export function isVeProviderConfigurationError(error: unknown): boolean {
  const message = errorMessage(error);
  return /\bSerper configuration:/i.test(message)
    || /\bSerper\s*(?:HTTP\s*)?[:(]?\s*(?:401|403)\b/i.test(message)
    || (/\bSerper\b/i.test(message) && /(?:missing|invalid|absent|rejected)[\s_-]+(?:api[\s_-]+)?key|api[\s_-]+key.{0,30}(?:missing|invalid|absent|rejected)/i.test(message));
}

export interface VeCollectionFailure {
  kind: 'billing' | 'configuration' | 'provider' | 'incomplete_checks' | 'name_cleanup' | 'source' | 'unknown';
  message: string;
}

export function getVeCollectionFailure(
  error: unknown,
  options: { relevanceCoverageComplete?: boolean | null } = {},
): VeCollectionFailure {
  const message = errorMessage(error);
  if (isVeProviderBillingError(message)) {
    return {
      kind: 'billing',
      message: /\bSerper\b/i.test(message)
        ? 'Нужно пополнить баланс сервиса поиска Serper. Автоматические повторы остановлены; собранные контакты сохранены.'
        : 'Недостаточно средств на балансе сервиса ИИ (Requesty). Автоматические повторы остановлены. Попросите администратора пополнить баланс, затем продолжите подготовку превью.',
    };
  }
  if (isVeProviderConfigurationError(message)) return {
    kind: 'configuration',
    message: 'Проверка остановлена: сервис поиска Serper не настроен или отклонил ключ либо запрос. Собранные контакты сохранены.',
  };
  if (/\bSerper transient:/i.test(message)) return {
    kind: 'provider',
    message: 'Автопроверка остановлена: сервис поиска Serper временно недоступен. Собранные контакты сохранены.',
  };
  if (/Очистка названий завершилась не полностью/i.test(message)) {
    return { kind: 'name_cleanup',
      message: 'Не удалось закончить очистку названий компаний. Собранные контакты сохранены; строки без проверенного названия не попадут в запуск. Продолжите подготовку превью — повторятся только незавершённые проверки.',
    };
  }
  if (options.relevanceCoverageComplete === false
    || /Проверка (?:релевантности|email) завершилась не полностью|relevance.{0,40}(?:incomplete|непол)/i.test(message)) {
    return {
      kind: 'incomplete_checks',
      message: 'Проверка релевантности или email завершилась не полностью. Непроверенные контакты не попадут в запуск. Продолжите подготовку превью, чтобы повторить незавершённую проверку.',
    };
  }
  if (/не покрывается каталогом/i.test(message)) {
    return {
      kind: 'source',
      message: 'Пробная выборка из каталога не соответствует выбранному направлению. Уточните гипотезу или загрузите свою базу.',
    };
  }
  if (/Сегмент исчерпан|не осталось новых строк/i.test(message)) {
    return {
      kind: 'source',
      message: 'В выбранных источниках не осталось новых контактов после исключения уже собранных. Это не означает, что исчерпан весь рынок. Выберите другую гипотезу или загрузите свою базу.',
    };
  }
  if (/Авто-сборка не дала строк|ошибка источника|companies_directory:|(?:hh_live|yandex_maps|google_maps):/i.test(message)) {
    return {
      kind: 'source',
      message: 'Не удалось получить контакты из выбранных источников. Повторите подготовку превью; если ошибка повторится, сообщите администратору.',
    };
  }
  return {
    kind: 'unknown',
    message: 'Подготовка превью остановлена из-за технической ошибки. Повторите попытку; если ошибка повторится, сообщите администратору. Непроверенные контакты не попадут в запуск.',
  };
}
