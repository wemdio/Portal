/**
 * Валидация и нормализация полной замены писем цепочки «Движка вертикалей»
 * (инлайн-редактор шага 3): 1..6 писем, у первого wait_days всегда 0.
 * Неизвестные поля письма ОТБРАСЫВАЕМ (не отклоняем), невалидные значения —
 * ошибка всего запроса.
 *
 * Вынесено из PATCH api/tools/vertical-engine-v2/chains/[id] — клиентский
 * ENG-контур редактирует письма тем же контрактом (api/client/eng/chains/[id]).
 * Тексты ошибок осознанно русские (совпадают со staff-роутом); клиентский
 * роут отдаёт обобщённую EN-ошибку, не проксируя детали.
 */

/** A/B-вариант письма по контракту данных (генерацию делает отдельная стадия). */
export interface VeLetterVariantRow {
  subject: string | null;
  body: string;
}

/** Форма jsonb-письма ve_chains.letters: основной вариант = «A», рядом variants. */
export interface VeChainLetterRow {
  subject: string | null;
  body: string;
  wait_days?: number;
  variants?: VeLetterVariantRow[];
  segment_variants?: unknown[];
}

export interface VeSegmentVariantRow {
  when: string;
  text: string;
}

export const VE_CHAIN_MAX_LETTERS = 6;
export const VE_CHAIN_MAX_BODY_LEN = 50_000;
export const VE_CHAIN_MAX_SUBJECT_LEN = 500;
export const VE_CHAIN_MAX_WAIT_DAYS = 90;

export function isVeLetterVariant(v: unknown): v is VeLetterVariantRow {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as VeLetterVariantRow).body === 'string' &&
    ((v as VeLetterVariantRow).subject === null || typeof (v as VeLetterVariantRow).subject === 'string')
  );
}

/** wait_days: приводим к целому и клампим в 0..90; нечисловое → 0. */
function clampWaitDays(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(VE_CHAIN_MAX_WAIT_DAYS, Math.max(0, Math.trunc(n)));
}

/** subject: null или строка ≤500 символов. */
function normalizeSubject(value: unknown): { ok: boolean; subject: string | null } {
  if (value === null || value === undefined) return { ok: true, subject: null };
  if (typeof value !== 'string' || value.length > VE_CHAIN_MAX_SUBJECT_LEN) {
    return { ok: false, subject: null };
  }
  return { ok: true, subject: value };
}

/** body: непустая строка ≤50000 символов. */
function isValidBody(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= VE_CHAIN_MAX_BODY_LEN;
}

function normalizeVariant(v: unknown): VeLetterVariantRow | null {
  if (typeof v !== 'object' || v === null) return null;
  const { subject, body } = v as { subject?: unknown; body?: unknown };
  if (!isValidBody(body)) return null;
  const s = normalizeSubject(subject);
  if (!s.ok) return null;
  return { subject: s.subject, body };
}

function normalizeSegmentVariant(v: unknown): VeSegmentVariantRow | null {
  if (typeof v !== 'object' || v === null) return null;
  const { when, text } = v as { when?: unknown; text?: unknown };
  if (typeof when !== 'string' || when.trim() === '' || typeof text !== 'string') return null;
  return { when, text };
}

/**
 * Полная замена letters. Возвращает нормализованный массив писем либо
 * текстовую ошибку (RU, как у staff-роута).
 */
export function normalizeVeChainLetters(input: unknown[]): { letters?: VeChainLetterRow[]; error?: string } {
  if (input.length < 1 || input.length > VE_CHAIN_MAX_LETTERS) {
    return { error: `Писем в цепочке должно быть от 1 до ${VE_CHAIN_MAX_LETTERS}` };
  }
  const out: VeChainLetterRow[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i];
    if (typeof raw !== 'object' || raw === null) {
      return { error: `Письмо ${i + 1} имеет неверный формат` };
    }
    const { subject, body, wait_days, variants, segment_variants } = raw as Record<
      string,
      unknown
    >;
    if (!isValidBody(body)) {
      return { error: `Тело письма ${i + 1} пустое или длиннее ${VE_CHAIN_MAX_BODY_LEN} символов` };
    }
    const s = normalizeSubject(subject);
    if (!s.ok) {
      return {
        error: `Тема письма ${i + 1} должна быть строкой до ${VE_CHAIN_MAX_SUBJECT_LEN} символов или null`,
      };
    }
    const letter: VeChainLetterRow = {
      subject: s.subject,
      body,
      wait_days: i === 0 ? 0 : clampWaitDays(wait_days),
    };
    if (variants !== undefined) {
      if (!Array.isArray(variants)) {
        return { error: `variants письма ${i + 1} должен быть массивом` };
      }
      const norm: VeLetterVariantRow[] = [];
      for (const v of variants) {
        const nv = normalizeVariant(v);
        if (!nv) return { error: `A/B-вариант письма ${i + 1} имеет неверный формат` };
        norm.push(nv);
      }
      letter.variants = norm;
    }
    if (segment_variants !== undefined) {
      if (!Array.isArray(segment_variants)) {
        return { error: `segment_variants письма ${i + 1} должен быть массивом` };
      }
      const norm: VeSegmentVariantRow[] = [];
      for (const v of segment_variants) {
        const nv = normalizeSegmentVariant(v);
        if (!nv) return { error: `Сегментный вариант письма ${i + 1} имеет неверный формат` };
        norm.push(nv);
      }
      letter.segment_variants = norm;
    }
    out.push(letter);
  }
  return { letters: out };
}
