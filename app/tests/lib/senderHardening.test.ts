/** @jest-environment node */
/**
 * Этап A хендоффа масштабирования сендера — чистая логика без БД:
 * классификация SMTP-отказов (кто виноват: адрес, ящик или сеть), разбор
 * отбойников из DSN, просьбы «стоп» и сравнение заголовков пробной отправки.
 */

jest.mock('server-only', () => ({}));
jest.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: null }));
jest.mock('@/lib/loggerServer', () => ({ logError: jest.fn(), logInfo: jest.fn() }));

import { classifySmtpError } from '@/lib/sender/smtp';
import {
  bounceIsPermanent,
  extractBounceStatus,
  isOwnMailboxReply,
  isStopRequest,
} from '@/lib/sender/replyClassify';
import { compareProbeHeaders } from '@/lib/sender/probeWorker';

describe('classifySmtpError: кто виноват в отказе', () => {
  const err = (message: string, responseCode?: number) =>
    Object.assign(new Error(message), responseCode == null ? {} : { responseCode });

  it('5.1.x — адреса нет: подавляем адрес', () => {
    expect(classifySmtpError(err('550 5.1.1 <a@b.ru>: Recipient address rejected', 550))).toBe('recipient_rejected');
    expect(classifySmtpError(err('550 5.1.10 recipient not found', 550))).toBe('recipient_rejected');
  });

  it('классический «user unknown» без кода тоже подавляет', () => {
    expect(classifySmtpError(err('550 User unknown', 550))).toBe('recipient_rejected');
    expect(classifySmtpError(err('554 no such recipient', 554))).toBe('recipient_rejected');
  });

  it('5.7.x — спам-политика: ящик на паузу, адрес не трогаем', () => {
    expect(classifySmtpError(err('550 5.7.1 Message rejected due to spam content', 550))).toBe('policy_reject');
    expect(classifySmtpError(err('554 5.7.1 Service unavailable; client host blocked', 554))).toBe('policy_reject');
  });

  it('голый 5xx без опознавательных признаков — отказ без подавления адреса', () => {
    expect(classifySmtpError(err('550 something went wrong', 550))).toBe('rejected');
  });

  it('квота дня остаётся rate_limit, а не уходит в 5xx-подавление', () => {
    expect(classifySmtpError(err('550 5.4.5 Daily user sending quota exceeded', 550))).toBe('rate_limit');
  });

  it('обрыв соединения во время SMTP-диалога — только ручной разбор, не ретрай', () => {
    expect(classifySmtpError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe('inflight_drop');
    expect(classifySmtpError(new Error('Socket closed unexpectedly'))).toBe('inflight_drop');
  });

  it('нет соединения — обычный сетевой ретрай', () => {
    expect(classifySmtpError(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }))).toBe('network');
    expect(classifySmtpError(Object.assign(new Error('getaddrinfo ENOTFOUND smtp.x.ru'), { code: 'ENOTFOUND' }))).toBe('network');
  });

  it('вход не прошёл и временные отказы — прежние классы', () => {
    expect(classifySmtpError(err('535 Authentication failed', 535))).toBe('auth');
    expect(classifySmtpError(err('451 Temporary local problem', 451))).toBe('temporary');
  });
});

describe('отбойники: вечное подавление только за «адреса нет»', () => {
  const dsn = (status: string) =>
    `This is a MIME-embedded message.\n\nFinal-Recipient: rfc822; lead@firm.ru\nStatus: ${status}\n`;

  it('код Status: вытаскивается из отчёта о недоставке', () => {
    expect(extractBounceStatus(dsn('5.1.1'))).toBe('5.1.1');
    expect(extractBounceStatus('нет отчёта')).toBeNull();
  });

  it('5.1.x — постоянный, переполнение и greylisting — нет', () => {
    expect(bounceIsPermanent('5.1.1')).toBe(true);
    expect(bounceIsPermanent('5.2.2')).toBe(false);
    expect(bounceIsPermanent('4.2.1')).toBe(false);
    // код не разобрался — консервативно считаем постоянным (прежнее поведение)
    expect(bounceIsPermanent(null)).toBe(true);
  });
});

describe('«стоп» в ответе уносит адрес в стоп-лист', () => {
  it('распознаётся в русском и английском тексте', () => {
    expect(isStopRequest('Спасибо, но отпишите меня от рассылки, пожалуйста', null)).toBe(true);
    expect(isStopRequest('Стоп. Больше не пишите.', null)).toBe(true);
    expect(isStopRequest('Please unsubscribe me from this list', 'Re: offer')).toBe(true);
  });

  it('обычный интерес стопом не считается', () => {
    expect(isStopRequest('Интересно, расскажите подробнее', 'Re: offer')).toBe(false);
    expect(isStopRequest('', 'Re: offer')).toBe(false);
  });
});

describe('письма между своими ящиками — прогрев, не ответы', () => {
  const own = new Set(['a@polza.online', 'b@polza.online']);
  it('свой адрес помечается, чужой — нет', () => {
    expect(isOwnMailboxReply('A@Polza.Online', own)).toBe(true);
    expect(isOwnMailboxReply('lead@firm.ru', own)).toBe(false);
    expect(isOwnMailboxReply(null, own)).toBe(false);
  });
});

describe('сравнение заголовков пробной отправки', () => {
  const sent = { from: 'roman@checkpolza.online', messageId: '<abc@checkpolza.online>' };

  it('нетронутые заголовки и пройденные проверки — passed', () => {
    const { checks, passed } = compareProbeHeaders(sent, {
      from: 'Roman <roman@checkpolza.online>',
      returnPath: '<roman@checkpolza.online>',
      dkimDomain: 'checkpolza.online',
      messageId: '<abc@checkpolza.online>',
      authResults: 'mx.google.com; spf=pass dkim=pass dmarc=pass',
    });
    expect(passed).toBe(true);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it('доменная ротация провайдера видна как расхождение From и DKIM', () => {
    const { checks, passed } = compareProbeHeaders(sent, {
      from: 'Roman <roman@polzatrust.ru>',
      returnPath: '<roman@polzatrust.ru>',
      dkimDomain: 'polzatrust.ru',
      messageId: '<abc@checkpolza.online>',
      authResults: 'spf=pass dkim=pass',
    });
    expect(passed).toBe(false);
    const from = checks.find((c) => c.check === 'From');
    expect(from?.ok).toBe(false);
    expect(from?.note).toContain('провайдер переписывает адрес');
    expect(checks.find((c) => c.check === 'DKIM d=')?.ok).toBe(false);
  });

  it('проваленный spf — строка с расхождением, даже если адреса не тронуты', () => {
    const { passed } = compareProbeHeaders(sent, {
      from: 'roman@checkpolza.online',
      returnPath: '<roman@checkpolza.online>',
      dkimDomain: 'checkpolza.online',
      messageId: '<abc@checkpolza.online>',
      authResults: 'spf=fail dkim=pass dmarc=pass',
    });
    expect(passed).toBe(false);
  });
});
