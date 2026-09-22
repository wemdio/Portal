/**
 * S6 — сборка цепочки «SDR hiring-trigger» (4 письма).
 *
 * Тексты перенесены ДОСЛОВНО из утверждённого файла (enagency_шаблоны_цепочек.txt
 * от 2026-09-11, раздел 2). Меняются только слоты:
 *   - развилка первого письма: подтверждённое гео+услуга против безопасного варианта;
 *   - кейс в письме 2: UK → Axisage, mobile → AppsLift, fintech/payments → INXY,
 *     иначе дефолт Itexus. Цифры кейсов не меняются никогда.
 *
 * Перед сохранением — детерминированные гарды (checkLetterRules + правила Polza).
 * Строка не прошла — needs_review, а не «подправить текст».
 */

import { checkLetterRules, extractNumberFacts, type VeLetterForCheck } from '@/lib/verticalEngineV2/letterChecks';
import type { PolzaOutreachLetter, PolzaLetterGuardResult } from './types';

const SIGNATURE = 'Julia Mira\nAccount Manager\nPolza Agency';

const OFFER = "We'll bring you 3 sales-qualified leads, or continue working for free until we do.";
// Утверждённые варианты оффера в письмах 2 и 4 — с маленькой буквы и с другим
// хвостом (enagency_шаблоны_цепочек.txt, версия 2026-09-11). Проверяем дословно.
const OFFER_LETTER2 = "we'll bring you 3 sales-qualified leads, or continue working for free until we achieve that result.";
const OFFER_LETTER4 = "we'll bring you 3 sales-qualified leads, or continue working for free until we do.";
const OFFER_LETTER3 = "If the campaign doesn't generate 3 sales-qualified leads, we'll continue working for free until it does.";

// ── Банк кейсов Polza (polzaagency.com/ru/cases, версия 2026-09-11) ──

interface PolzaCase {
  id: string;
  name: string;
  /** Контекст кейса для письма 2, слот после имени. */
  context: string;
  /** Что делала Polza; null — если в подтверждённых данных только контекст и результат. */
  action: string | null;
  /** Подтверждённый результат, дословно. */
  result: string;
}

const CASES = {
  itexus: {
    id: 'itexus',
    name: 'Itexus',
    context: 'a FinTech and SaaS development company selling in the US and Europe',
    action: 'Polza tested more than 16 hypotheses with account-level personalization',
    result: 'The campaign generated 12 qualified leads per month and one large development deal',
  },
  axisage: {
    id: 'axisage',
    name: 'Axisage',
    context: 'a UK company',
    action: 'Polza narrowed the ICP first',
    result: 'The campaign generated 7 leads in the first month',
  },
  appslift: {
    id: 'appslift',
    name: 'AppsLift',
    context: 'a mobile development company selling in the US and Europe',
    action: null,
    result: 'The campaign generated 14 leads in the first month',
  },
  inxy: {
    id: 'inxy',
    name: 'INXY',
    context: 'a B2B payments company',
    action: 'Polza targeted finance decision-makers',
    result: 'The campaign generated 12 leads',
  },
} as const satisfies Record<string, PolzaCase>;

export type PolzaCaseId = keyof typeof CASES;

function caseParagraph(c: PolzaCase): string {
  return `For ${c.name}, ${c.context}, ${c.action ? `${c.action}. ` : ''}${c.result}.`;
}

/**
 * Выбор кейса: UK (подтверждённое гео) → Axisage; услуга mobile → AppsLift;
 * fintech/payments → INXY; иначе Itexus.
 */
export function selectCase(
  targetSalesGeo: string | null,
  geoConfidence: string | null,
  serviceLine: string | null,
): PolzaCase {
  const geo = (targetSalesGeo ?? '').toLowerCase();
  const geoConfirmed = geoConfidence === 'high' || geoConfidence === 'medium';
  const service = (serviceLine ?? '').toLowerCase();
  if (geoConfirmed && (geo.includes('uk') || geo.includes('united kingdom'))) {
    return CASES.axisage;
  }
  if (/\b(mobile|ios|android|flutter|react native)\b/.test(service)) {
    return CASES.appslift;
  }
  if (/\b(fintech|payments?|banking|financial)\b/.test(service)) {
    return CASES.inxy;
  }
  return CASES.itexus;
}

// ── Шаблоны (дословно; {…} — единственные слоты) ──

const LETTER1_TEMPLATE = (signalLine: string) => `Hi,

We have yet to be properly introduced, but I'm Julia, an Account Manager at Polza Agency.

${signalLine}

The challenge is that without a separate account thesis, outbound often blends this offer into another generic development pitch.

Polza tests narrow account hypotheses around product leaders who need a dependable delivery bench, observable buying signals, and explicit exclusions before scaling email volume.

We'll bring you 3 sales-qualified leads, or continue working for free until we do.

Would it be useful if I sent you a one-page example of the account thesis we could test?

Julia Mira
Account Manager
Polza Agency`;

const LETTER2_TEMPLATE = (caseName: string, caseText: string, useCaseLine: string) => `Hi,

A fair concern with lead-generation agencies is that generic prospect lists can generate replies without creating qualified project opportunities.

${caseText}

We would start more narrowly: as an external SDR function, we'd test one ${useCaseLine} use case, explicit qualification criteria, and clear exclusions before you increase outreach volume or expand the internal team.

Our offer is simple: we'll bring you 3 sales-qualified leads, or continue working for free until we achieve that result.

Would the ${caseName} targeting breakdown help you judge whether this approach is worth testing?

Julia Mira
Account Manager
Polza Agency`;

const LETTER3_BODY = `Hi,

Since you're hiring an SDR, a lower-risk first step could be to validate the outbound motion with one practical campaign split:

Product leaders who need a dependable delivery bench.
SaaS teams hiring too slowly to meet their product roadmap.

Relevant signals could include open engineering roles, release pressure, and newly funded product development.

We would exclude staffing requests without a defined product owner, delivery scope, or active business need.

That turns broad prospecting into a testable account set with different messaging for each buying context.

If the campaign doesn't generate 3 sales-qualified leads, we'll continue working for free until it does.

Should I send you the signal checklist behind this split?

Julia Mira
Account Manager
Polza Agency`;

const LETTER4_BODY = `Hi,

I'll leave this here.

If you're still deciding whether to hire an SDR for this motion, Polza can run the first outbound test as an external team.

If it is relevant, the offer is straightforward: we'll bring you 3 sales-qualified leads, or continue working for free until we do.

To reduce the risk on your side, the agreement and payment can also be handled through an independent escrow service, so the transaction is protected for both parties.

Should I pause, or send the one-page campaign outline?

Julia Mira
Account Manager
Polza Agency`;

// Темы нейтральны: без дат, годов, «leading/full-service/end-to-end»
// (в утверждённом файле SDR-цепочки темы не заданы — только для персонализированной).
const SUBJECTS = {
  1: 'Before you hire the next SDR',
  2: (caseName: string) => `How ${caseName} tested outbound before scaling`,
  3: 'A practical first campaign split',
  4: 'Closing the loop',
} as const;

export interface BuildLettersInput {
  targetSalesGeo: string | null;
  targetSalesGeoConfidence: string | null;
  serviceLine: string | null;
  serviceLineConfident: boolean;
}

const DEFAULT_USE_CASE = 'dedicated engineering teams';

export function buildLetters(input: BuildLettersInput): PolzaOutreachLetter[] {
  const geoConfirmed = input.targetSalesGeoConfidence === 'high' || input.targetSalesGeoConfidence === 'medium';
  const geoNamed = geoConfirmed && Boolean(input.targetSalesGeo);
  const confidentUseCase = input.serviceLineConfident && Boolean(input.serviceLine);

  // Развилка первого письма (план, шаг 7): подтверждённое гео + услуга →
  // персонализация; иначе безопасная формулировка из утвержденной цепочки.
  let signalLine: string;
  if (geoNamed && confidentUseCase) {
    signalLine = `I saw that you're hiring an SDR to build pipeline for ${input.serviceLine} in ${input.targetSalesGeo}.`;
  } else if (confidentUseCase) {
    signalLine = `I saw that you're hiring an SDR. If the role is meant to build pipeline for ${input.serviceLine}, Polza can test that motion as an external SDR function before you add fixed headcount.`;
  } else {
    signalLine = `I saw that you're hiring an SDR. If the role is meant to build pipeline for your ${DEFAULT_USE_CASE}, Polza can test that motion as an external SDR function before you add fixed headcount.`;
  }

  const useCaseLine = confidentUseCase ? (input.serviceLine as string) : DEFAULT_USE_CASE;
  const chosenCase = selectCase(input.targetSalesGeo, input.targetSalesGeoConfidence, input.serviceLine);

  return [
    { n: 1, subject: SUBJECTS[1], body: LETTER1_TEMPLATE(signalLine) },
    { n: 2, subject: SUBJECTS[2](chosenCase.name), body: LETTER2_TEMPLATE(chosenCase.name, caseParagraph(chosenCase), useCaseLine) },
    { n: 3, subject: SUBJECTS[3], body: LETTER3_BODY },
    { n: 4, subject: SUBJECTS[4], body: LETTER4_BODY },
  ];
}

// ── Гарды ──

const BANNED_WORDS_RE = /\b(leading|full-service|end-to-end)\b/i;
const YEAR_RE = /\b(19|20)\d{2}\b/;
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}/;

/**
 * Детерминированные гарды Polza поверх checkLetterRules (en-TELLS, один CTA,
 * тире, фактчек цифр). Числа в письмах обязаны быть из банка кейсов.
 */
export function guardLetters(letters: PolzaOutreachLetter[]): PolzaLetterGuardResult {
  const violations: string[] = [];

  // Корпус чисел: банк кейсов (16, 12, 7, 14) + оффер («3 sales-qualified»).
  const allCasesText = Object.values(CASES).map((c) => caseParagraph(c)).join('\n');
  const facts = extractNumberFacts(`${allCasesText}\n${OFFER}\n${OFFER_LETTER3}`);

  const veLetters: VeLetterForCheck[] = letters.map((letter) => ({ subject: letter.subject, body: letter.body }));
  for (const v of checkLetterRules(veLetters, 'en', facts)) {
    violations.push(`letter ${v.letter}: ${v.rule} — ${v.detail}`);
  }

  letters.forEach((letter, index) => {
    const label = `letter ${index + 1}`;
    const lines = letter.body.split('\n').map((l) => l.trim());
    const firstLine = lines.find(Boolean) ?? '';
    if (firstLine !== 'Hi,') violations.push(`${label}: обращение должно быть строго «Hi,»`);
    if (!letter.body.trim().endsWith(SIGNATURE)) {
      violations.push(`${label}: подпись должна быть строго Julia Mira / Account Manager / Polza Agency`);
    }
    if (BANNED_WORDS_RE.test(letter.subject) || BANNED_WORDS_RE.test(letter.body)) {
      violations.push(`${label}: запрещённое слово (leading/full-service/end-to-end)`);
    }
    if (YEAR_RE.test(letter.subject) || ISO_DATE_RE.test(letter.subject) || YEAR_RE.test(letter.body) || ISO_DATE_RE.test(letter.body)) {
      violations.push(`${label}: в письме не должно быть дат и годов`);
    }
  });

  const letter1 = letters[0];
  if (letter1) {
    if (!letter1.body.includes(OFFER)) violations.push('letter 1: дословный оффер отсутствует');
    // Сигнал — первое предложение со фактом найма (до точки). Рамка «If the
    // role is meant…» из утверждённого шаблона — не сигнал, её не считаем.
    const signalLine = letter1.body
      .split('\n')
      .find((l) => l.includes("I saw that you're hiring an SDR"))
      ?.split('. ')[0] ?? '';
    if (signalLine) {
      const words = signalLine.split(/\s+/).filter(Boolean).length;
      const commas = (signalLine.match(/,/g) ?? []).length;
      if (words > 20) violations.push(`letter 1: сигнал длиннее 20 слов (${words})`);
      if (commas > 1) violations.push(`letter 1: в сигнале больше одной запятой (${commas})`);
    } else {
      violations.push('letter 1: строка-сигнал не найдена');
    }
  }

  const letter2 = letters[1];
  if (letter2) {
    if (!letter2.body.includes(OFFER_LETTER2)) violations.push('letter 2: дословный оффер отсутствует');
    const caseMentions = Object.values(CASES).filter((c) => letter2.body.includes(`For ${c.name},`));
    if (caseMentions.length !== 1) {
      violations.push('letter 2: ровно один кейс на письмо');
    } else if (!letter2.body.includes(caseMentions[0].result)) {
      violations.push('letter 2: цифры кейса не совпадают с банком кейсов');
    }
  }

  const letter3 = letters[2];
  if (letter3 && !letter3.body.includes(OFFER_LETTER3)) {
    violations.push('letter 3: дословная формулировка оффера отсутствует');
  }
  const letter4 = letters[3];
  if (letter4 && !letter4.body.includes(OFFER_LETTER4)) {
    violations.push('letter 4: дословный оффер отсутствует');
  }

  return { ok: violations.length === 0, violations };
}
