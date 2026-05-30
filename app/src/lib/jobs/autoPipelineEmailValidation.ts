/**
 * Email validation adapter for the auto-pipeline.
 *
 * Полная цепочка validator.ts (syntax → MX → SMTP) красиво подходит для
 * production-валидации, но в локальной разработке/dry-run у нас может не быть
 * настроенного SMTP_PROXY_URLS — direct-port-25 connections выключены, чтобы
 * не палить IP. В таком случае validateEmail бросит исключение.
 *
 * Этот адаптер:
 *   1. Делает syntax check + MX lookup (всегда дёшево).
 *   2. Если SMTP_PROXY_URLS настроен — добавляет SMTP-проверку через validator.
 *   3. Возвращает компактный enum-статус для записи в seen_employers.
 *
 * Используем domainCache, чтобы один и тот же домен не валидировался дважды
 * (валидатор внутри тоже умеет кешировать MX, но мы вызываем его в разных
 * шагах с разными целями, поэтому держим кеш снаружи).
 */

import { validateEmail, lookupMX } from '@/lib/emailValidation/validator';
import { checkSyntax, isDisposable, isFreeProvider, isRole } from '@/lib/emailValidation/shared';
import type { DomainInfo, ValidationResult } from '@/lib/emailValidation/shared';

export type AutoPipelineEmailValidationStatus =
  | 'valid'
  | 'invalid_syntax'
  | 'no_mx'
  | 'smtp_reject'
  | 'smtp_unknown'
  | 'role_address'
  | 'disposable'
  | 'catch_all'
  | 'free_provider'
  | 'not_validated';

export interface AutoPipelineEmailValidation {
  status: AutoPipelineEmailValidationStatus;
  /** Coarse «это валидный готовый-к-отправке контакт?» bit для воронки. */
  isValid: boolean;
  /** Сырой результат validator'а (если SMTP сделан) или syntax/MX-результат. */
  details: Record<string, unknown>;
}

/**
 * Возвращает true если в окружении настроен SMTP-прокси и можно делать
 * полноценную SMTP-валидацию. В локальной разработке (без прокси) пропускаем
 * SMTP-шаг и валидируем только до MX.
 */
function smtpProxyAvailable(): boolean {
  const v = process.env.SMTP_PROXY_URLS;
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Lite-валидация: syntax + MX. Без SMTP. Используется когда SMTP-прокси
 * недоступен. Возвращает 'valid' если syntax корректный И MX-запись есть —
 * это не гарантирует что mailbox существует, но это лучшее что мы можем
 * сделать без SMTP.
 */
async function liteValidate(
  email: string,
  domainCache: Map<string, DomainInfo>,
): Promise<AutoPipelineEmailValidation> {
  const normalized = email.trim().toLowerCase();
  const syntax = checkSyntax(normalized);
  if (!syntax.valid) {
    return {
      status: 'invalid_syntax',
      isValid: false,
      details: { step: 'syntax', error: syntax.error, email: normalized },
    };
  }

  const atIndex = normalized.lastIndexOf('@');
  const local = normalized.substring(0, atIndex);
  const domain = normalized.substring(atIndex + 1);

  // Эти три проверки — синхронные, чисто по словарям/regex'ам.
  if (isDisposable(domain)) {
    return {
      status: 'disposable',
      isValid: false,
      details: { step: 'disposable', email: normalized },
    };
  }

  const cached = domainCache.get(domain);
  let mxFound: boolean;
  let mxHosts: string[];
  if (cached) {
    mxFound = cached.mxFound;
    mxHosts = cached.mxHosts;
  } else {
    const mx = await lookupMX(domain);
    mxFound = mx.found;
    mxHosts = mx.mxHosts;
    domainCache.set(domain, {
      domain,
      mxHosts,
      mxFound,
      isCatchAll: null,
      isDisposable: false,
      checkedAt: new Date(),
    });
  }

  if (!mxFound) {
    return {
      status: 'no_mx',
      isValid: false,
      details: { step: 'mx', email: normalized },
    };
  }

  // Roles и free-providers — не дисквалифицируют, но помечаем для аналитики.
  // Это рабочие адреса (info@, sales@, hr@), на которые в B2B-аутрич реально
  // приходят ответы. Lite-режим считает их valid.
  if (isRole(local)) {
    return {
      status: 'role_address',
      isValid: true,
      details: { step: 'role', email: normalized, mxHosts },
    };
  }
  if (isFreeProvider(domain)) {
    return {
      status: 'free_provider',
      isValid: true,
      details: { step: 'free', email: normalized, mxHosts },
    };
  }

  return {
    status: 'valid',
    isValid: true,
    details: { step: 'mx', email: normalized, mxHosts, mode: 'lite' },
  };
}

/**
 * Полная валидация через validator.ts (syntax → MX → SMTP). Используется
 * когда SMTP_PROXY_URLS настроен (т.е. в проде).
 */
async function fullValidate(
  email: string,
  domainCache: Map<string, DomainInfo>,
): Promise<AutoPipelineEmailValidation> {
  let result: ValidationResult;
  try {
    result = await validateEmail(email, domainCache);
  } catch (err) {
    // Если validator бросил — это обычно «SMTP_PROXY_URLS not configured» или
    // транспорт. Не валим прогон — помечаем как smtp_unknown и идём дальше.
    return {
      status: 'smtp_unknown',
      isValid: false,
      details: {
        step: 'smtp',
        error: err instanceof Error ? err.message : String(err),
        email,
      },
    };
  }

  // Маппинг ValidationResult → AutoPipelineEmailValidationStatus.
  const status: AutoPipelineEmailValidationStatus = (() => {
    if (result.result === 'invalid') {
      const step = (result.details as { step?: string }).step;
      if (step === 'syntax') return 'invalid_syntax';
      if (step === 'mx') return 'no_mx';
      if (result.smtp_code >= 500) return 'smtp_reject';
      return 'smtp_reject';
    }
    if (result.result === 'disposable') return 'disposable';
    if (result.result === 'catch_all') return 'catch_all';
    if (result.result === 'unknown') return 'smtp_unknown';
    // result === 'ok'
    if (result.is_role) return 'role_address';
    if (result.is_free) return 'free_provider';
    return 'valid';
  })();

  // isValid: считаем «готовым» то что достижимо ИЛИ не бьёт по репутации.
  // role_address (info@/sales@) и free_provider (mail.ru/yandex) — рабочие
  // адреса для B2B SMB (см. shared.ts). catch_all берём В РАБОТУ: сервер
  // принимает любой адрес → нулевой риск hard-bounce, а role-адреса на
  // catch-all почти всегда доходят до общего ящика компании. Раньше
  // исключали как «risky» — по решению расширяем воронку. (Routing их и так
  // не фильтровал по isValid — теперь они ещё и считаются «готовыми».)
  const isValid =
    result.result === 'ok' ||
    status === 'role_address' ||
    status === 'free_provider' ||
    status === 'catch_all';

  return {
    status,
    isValid,
    details: { ...result.details, result: result.result, quality: result.quality, smtp_code: result.smtp_code },
  };
}

/**
 * Главный API адаптера.
 *
 * Делает full-validation если в окружении настроен SMTP-прокси, иначе lite.
 * Никогда не бросает — все ошибки превращаются в status='smtp_unknown' с
 * деталями в details, чтобы один битый email не валил весь прогон пайплайна.
 */
export async function validateEmailForAutoPipeline(
  email: string,
  domainCache: Map<string, DomainInfo>,
): Promise<AutoPipelineEmailValidation> {
  if (smtpProxyAvailable()) {
    return fullValidate(email, domainCache);
  }
  return liteValidate(email, domainCache);
}
