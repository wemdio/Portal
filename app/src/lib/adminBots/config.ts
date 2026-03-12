/**
 * Bot Manager: list of bots connected to the portal.
 * - Container bots: health-check, atmos-bot (controlled via Docker when socket available).
 * - In-app bot: tg-agent (runs inside portal; no start/stop, logs from application_logs).
 */

export const BOT_IDS = ['health-check', 'atmos-bot', 'tg-agent'] as const;
export type BotId = (typeof BOT_IDS)[number];

export type BotKind = 'container' | 'in-app';

export interface BotConfig {
  id: BotId;
  name: string;
  description: string;
  kind: BotKind;
  /** Docker container name when kind === 'container' */
  containerName: string | null;
}

export const BOTS: BotConfig[] = [
  {
    id: 'health-check',
    name: 'Health-check',
    description: 'Проверка доступности портала, БД, прокси, S3; алерты в Telegram',
    kind: 'container',
    containerName: 'portal-health-check',
  },
  {
    id: 'atmos-bot',
    name: 'Atmos-bot',
    description: 'Анализ атмосферы чатов Telegram, алерты и отчёты',
    kind: 'container',
    containerName: 'portal-atmos-bot',
  },
  {
    id: 'tg-agent',
    name: 'TG-агент',
    description: 'Бот для взаимодействия с порталом через Telegram (встроен в портал)',
    kind: 'in-app',
    containerName: null,
  },
];

export function getBotById(id: string): BotConfig | undefined {
  return BOTS.find((b) => b.id === id);
}

export function getContainerBots(): BotConfig[] {
  return BOTS.filter((b) => b.kind === 'container');
}
