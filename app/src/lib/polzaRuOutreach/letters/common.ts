/**
 * Общие куски сборки писем: подпись, самопредставление, блок кейса, блок
 * механики, утверждённые claims оффера.
 *
 * Письма 2+ идут ответом в той же ветке — своей темы у них нет (subject '').
 */

import { formatSignature, senderFirstName, type CaseRecord, type OfferClaim, type SenderProfile } from '../libraries';
import type { Letter } from '../types';

export interface LetterContext {
  brand: string;
  sender: SenderProfile;
  isRouting: boolean;
  caseRecord: CaseRecord | null;
  claims: OfferClaim[];
}

export interface AssembledChain {
  letters: Letter[];
  subjectB: string | null;
  caseId: string | null;
  claimIds: string[];
}

export function q(brand: string): string {
  return `«${brand}»`;
}

export function signed(body: string, sender: SenderProfile): string {
  return `${body.trim()}\n\nС уважением,\n${formatSignature(sender)}`;
}

/** «Егор, Polza Agency» — имя и компания только из профиля отправителя. */
export function intro(sender: SenderProfile, short = false): string {
  const company = short ? sender.company_name.replace(/\s+Agency$/i, '') : sender.company_name;
  return `${senderFirstName(sender)}, ${company}`;
}

/** Утверждённое утверждение оффера по ключу; нет активной записи — null (нейтральный текст). */
export function claim(ctx: LetterContext, key: string): OfferClaim | null {
  return ctx.claims.find((c) => c.claim_key === key) ?? null;
}

export function caseBlock(ctx: LetterContext): string | null {
  return ctx.caseRecord ? `Для примера: ${ctx.caseRecord.case_text_short.trim()}` : null;
}

/** Абзацы без пустых блоков: условная переменная без данных удаляется целиком. */
export function paragraphs(...parts: Array<string | null | undefined | false>): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim())
    .join('\n\n');
}

export function usedClaimIds(...claims: Array<OfferClaim | null>): string[] {
  return claims.filter((c): c is OfferClaim => Boolean(c)).map((c) => c.id);
}
