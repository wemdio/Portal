export async function readApiError(response: Response): Promise<string> {
  if (response.status === 401) return 'Сессия истекла. Обновите страницу и войдите снова.';

  const raw = await response.text().catch(() => '');
  if (!raw) return `Ошибка запроса: ${response.status}`;

  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error;
    }
  } catch {
    // Gateways can return an HTML maintenance page instead of an API body.
  }

  if (/^\s*</.test(raw)) {
    return `Сервер вернул неожиданный ответ (${response.status}). Попробуйте позже.`;
  }
  return raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
}
