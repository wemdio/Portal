/** @jest-environment node */

/**
 * Один контакт — одна передача.
 *
 * Отправить человека и менеджеру по лидам, и в партнёрскую программу значит
 * посадить на него двух людей, которые начнут два разных разговора. Отозвать
 * уже ушедшее сообщение нельзя, поэтому проверка стоит до отправки, а не после.
 */

import { checkForwardConflict, cancelBlockReason, type ExistingForward } from '@/lib/tgOutreach/forwardConflict';

const forward = (over: Partial<ExistingForward> = {}): ExistingForward => ({
  kind: 'lead',
  status: 'sent',
  requested_at: '2026-08-12T09:00:00.000Z',
  sent_at: '2026-08-12T09:05:00.000Z',
  ...over,
});

describe('checkForwardConflict', () => {
  it('передач не было — можно любой вид', () => {
    expect(checkForwardConflict([], 'lead')).toBeNull();
    expect(checkForwardConflict([], 'partner')).toBeNull();
  });

  it('уже отправлен лидом — партнёром не отправить', () => {
    const msg = checkForwardConflict([forward({ kind: 'lead' })], 'partner');
    expect(msg).toContain('уже передан как «лид»');
    expect(msg).toContain('два менеджера');
  });

  it('уже отправлен партнёром — лидом не отправить', () => {
    const msg = checkForwardConflict([forward({ kind: 'partner' })], 'lead');
    expect(msg).toContain('уже передан как «кандидат в партнёры»');
  });

  it('повтор того же вида тоже не пропускаем — сообщение задвоится', () => {
    const msg = checkForwardConflict([forward({ kind: 'lead' })], 'lead');
    expect(msg).toContain('уже передан');
    expect(msg).toContain('задвоит');
  });

  it('стоит в очереди — блокирует обе кнопки', () => {
    const queued = [forward({ kind: 'lead', status: 'pending', sent_at: null })];
    expect(checkForwardConflict(queued, 'partner')).toContain('уже стоит в очереди');
    expect(checkForwardConflict(queued, 'lead')).toContain('уже стоит в очереди');
  });

  /**
   * Упавшая передача до адресата не дошла. Запретить повтор — значит оставить
   * оператора без единственного способа довести дело до конца.
   */
  it('упавшая передача не блокирует ничего', () => {
    const failed = [forward({ kind: 'lead', status: 'failed', sent_at: null })];
    expect(checkForwardConflict(failed, 'lead')).toBeNull();
    expect(checkForwardConflict(failed, 'partner')).toBeNull();
  });

  it('после неудачи и успеха решает успех', () => {
    const history = [
      forward({ kind: 'partner', status: 'sent' }),
      forward({ kind: 'lead', status: 'failed', sent_at: null }),
    ];
    expect(checkForwardConflict(history, 'lead')).toContain('уже передан как «кандидат в партнёры»');
  });

  /** Ожидающую ещё можно снять, ушедшую — нет, поэтому про неё говорим первой. */
  it('ожидающая важнее ушедшей в тексте отказа', () => {
    const history = [
      forward({ kind: 'lead', status: 'sent' }),
      forward({ kind: 'partner', status: 'pending', sent_at: null }),
    ];
    expect(checkForwardConflict(history, 'lead')).toContain('очереди');
  });

  /**
   * Снятая передача до менеджера не дошла — ровно как упавшая. Держать после
   * отмены заблокированные кнопки значило бы наказывать за исправление ошибки.
   */
  it('отменённая передача не блокирует новую', () => {
    const cancelled = [forward({ kind: 'lead', status: 'cancelled', sent_at: null })];
    expect(checkForwardConflict(cancelled, 'lead')).toBeNull();
    expect(checkForwardConflict(cancelled, 'partner')).toBeNull();
  });
});

describe('cancelBlockReason', () => {
  it('ожидающую отправки — снимаем', () => {
    expect(cancelBlockReason(forward({ status: 'pending', sent_at: null }))).toBeNull();
  });

  /**
   * Главная защита: воркер мог отправить задачу как раз между тем, как оператор
   * увидел «в очереди», и тем, как нажал «Отменить».
   */
  it('ушедшую не отменить — из Telegram не отзовёшь', () => {
    const msg = cancelBlockReason(forward({ kind: 'lead', status: 'sent' }));
    expect(msg).toContain('уже ушла менеджеру');
    expect(msg).toContain('отозвать');
  });

  it('упавшую отменять нечего — она и так не в очереди', () => {
    expect(cancelBlockReason(forward({ status: 'failed', sent_at: null })))
      .toContain('уже не в очереди');
  });

  it('снятую повторно не снять', () => {
    expect(cancelBlockReason(forward({ status: 'cancelled', sent_at: null })))
      .toContain('уже не в очереди');
  });

  it('передачи вообще не было', () => {
    expect(cancelBlockReason(null)).toContain('отменять нечего');
  });
});
