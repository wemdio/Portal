/** Browser-safe presentation of the explicit wait marker. Never copy provider
 * text, key identity or credit details into a user-facing message. */
export interface VeRequestyBillingWaitState {
  title: string;
  description: string;
  requiresAdmin: boolean;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const PUBLIC_PROBE_REASONS = new Set(['missing_api_key', 'invalid_api_key', 'authentication_failed',
  'management_forbidden', 'rate_limited', 'provider_unavailable', 'http_error', 'invalid_response',
  'response_too_large', 'timeout', 'aborted', 'network_error', 'group_budget_unknown',
  'insufficient_balance', 'key_limit_reached', 'completions_forbidden', 'awaiting_credit_change']);

/** Project responses retain ordinary payload fields but omit recovery internals. */
export function redactVeRequestyBillingPayload(payload: unknown): unknown {
  const source = record(payload);
  if (!source) return payload;
  const result = { ...source };
  delete result.requesty_billing_recovery;
  if ('requesty_billing_wait' in source) {
    const wait = record(source.requesty_billing_wait);
    result.requesty_billing_wait = wait?.version === 1 && typeof wait.blocked_at === 'string'
      && Number.isFinite(Date.parse(wait.blocked_at)) ? {
        version: 1, blocked_at: wait.blocked_at,
        ...(['blocked', 'unavailable'].includes(String(wait.probe_status)) ? { probe_status: wait.probe_status } : {}),
        ...(typeof wait.probe_reason === 'string' && PUBLIC_PROBE_REASONS.has(wait.probe_reason)
          ? { probe_reason: wait.probe_reason } : {}),
      } : null;
  }
  return result;
}

export function veRequestyBillingWaitState(payload: unknown): VeRequestyBillingWaitState | null {
  const wait = record(record(payload)?.requesty_billing_wait);
  if (wait?.version !== 1 || typeof wait.blocked_at !== 'string'
    || !Number.isFinite(Date.parse(wait.blocked_at))) return null;
  if (wait.probe_status === 'unavailable') {
    if (['timeout', 'aborted', 'network_error', 'rate_limited', 'provider_unavailable'].includes(String(wait.probe_reason))) return {
      title: 'Проверка баланса Requesty отложена',
      description: 'Проверим ещё раз автоматически. Повторный запуск не нужен.',
      requiresAdmin: false,
    };
    return wait.probe_reason === 'management_forbidden' ? {
      title: 'Нужен доступ к балансу Requesty',
      description: 'Администратору нужно разрешить проверку баланса. Результаты сохранены.',
      requiresAdmin: true,
    } : {
      title: 'Не удалось проверить баланс Requesty',
      description: 'Администратору нужно проверить доступ и лимиты Requesty. Результаты сохранены.',
      requiresAdmin: true,
    };
  }
  if (wait.probe_reason === 'completions_forbidden') return {
    title: 'Нужен доступ к ИИ Requesty',
    description: 'Администратору нужно проверить доступ к ИИ Requesty. Результаты сохранены.',
    requiresAdmin: true,
  };
  if (wait.probe_reason === 'key_limit_reached') return {
    title: 'Ожидаем доступного лимита Requesty',
    description: 'Лимит ключа исчерпан. После его обновления продолжим автоматически.',
    requiresAdmin: true,
  };
  return {
    title: 'Ожидаем пополнения Requesty',
    description: 'Результаты сохранены. Продолжим автоматически после подтверждения баланса.',
    requiresAdmin: false,
  };
}

export function veRequestyBillingWaitMessage(payload: unknown): string | null {
  return veRequestyBillingWaitState(payload)?.description ?? null;
}
