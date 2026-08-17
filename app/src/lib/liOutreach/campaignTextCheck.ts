import { findUnknownPlaceholders, supportedVarsHint } from './messageVars';

/**
 * Save-time guard for campaign texts.
 *
 * A merge tag nothing can fill is wiped to an empty string at send time (it
 * has to be — raw `{{...}}` reaching a lead is worse). That makes a typo
 * invisible: the campaign looks fine in the editor, the logs look fine, the
 * health digest stays green, and the lead gets «Здравствуйте, Обратил внимание
 * на Kommo». Catching it here, while the operator is still looking at the
 * text, is the only cheap moment.
 */

interface CampaignTextSource {
  welcome_message?: unknown;
  steps?: unknown;
}

/** Every unknown tag across welcome + step messages, deduplicated. */
export function collectUnknownPlaceholders(body: CampaignTextSource): string[] {
  const texts: string[] = [];
  if (typeof body.welcome_message === 'string') texts.push(body.welcome_message);
  if (Array.isArray(body.steps)) {
    for (const step of body.steps) {
      const message = (step as { message?: unknown } | null)?.message;
      if (typeof message === 'string') texts.push(message);
    }
  }
  const unknown = new Set<string>();
  for (const text of texts) {
    for (const tag of findUnknownPlaceholders(text)) unknown.add(tag);
  }
  return [...unknown];
}

/** Operator-facing message: what's wrong and what may be used instead. */
export function unknownPlaceholderError(unknown: string[]): string {
  const list = unknown.map((v) => `{{${v}}}`).join(', ');
  return (
    `В текстах кампании есть переменные, которых нет: ${list}. ` +
    `Они не подставятся, а молча исчезнут из сообщения — лид получит текст без них. ` +
    `Доступные переменные: ${supportedVarsHint()}`
  );
}
