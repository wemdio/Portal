const TEAM_PROJECT_FALLBACK_LABEL = 'Проект';

export function formatTeamProjectLabel(
  clientValue: string | null | undefined,
  serviceValue: string | null | undefined,
): string {
  const client = clientValue?.trim() || '';
  const service = serviceValue?.trim() || '';

  if (!client) return service || TEAM_PROJECT_FALLBACK_LABEL;
  if (!service) return client;
  if (client.toLocaleLowerCase('ru-RU') === service.toLocaleLowerCase('ru-RU')) {
    return client;
  }
  return `${client} · ${service}`;
}
