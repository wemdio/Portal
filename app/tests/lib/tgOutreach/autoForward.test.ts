/** @jest-environment node */

/**
 * Отметка «этот контакт уже ушёл менеджеру».
 *
 * Автопересылка по положительному триггеру уходит без ведома оператора, и до
 * этой отметки её было не отличить от статуса «Лид», проставленного руками.
 * Второй разговор о том же человеке начинается ровно отсюда: оператор не видит,
 * что менеджер уже читает переписку, и передаёт контакт ещё раз.
 */

import {
  describeAutoForward,
  autoForwardWarning,
  type AutoForwardFields,
} from '@/lib/tgOutreach/autoForward';

const sent = (over: Partial<AutoForwardFields> = {}): AutoForwardFields => ({
  auto_forwarded_at: '2026-08-12T15:26:00.000Z',
  auto_forward_chat: '@KazaninaAE_AO',
  auto_forward_error: null,
  ...over,
});

describe('describeAutoForward', () => {
  it('пересылки не было — отметки нет', () => {
    expect(describeAutoForward({})).toBeNull();
    expect(describeAutoForward({ auto_forwarded_at: null, auto_forward_error: null })).toBeNull();
  });

  it('ушла — отметка с чатом и временем', () => {
    expect(describeAutoForward(sent())).toEqual({
      state: 'sent',
      chat: '@KazaninaAE_AO',
      at: '2026-08-12T15:26:00.000Z',
    });
  });

  it('чат в отметке может отсутствовать — старые записи его не хранили', () => {
    expect(describeAutoForward(sent({ auto_forward_chat: null }))).toEqual({
      state: 'sent',
      chat: null,
      at: '2026-08-12T15:26:00.000Z',
    });
  });

  /**
   * Сбой автопересылки — это лид, который не доехал до менеджера. Раньше он
   * оседал строкой в журнале кампании, а диалог снаружи выглядел как успешный.
   */
  it('не ушла — отметка о сбое с причиной', () => {
    const mark = describeAutoForward({
      auto_forwarded_at: null,
      auto_forward_chat: '@KazaninaAE_AO',
      auto_forward_error: 'CHAT_WRITE_FORBIDDEN',
    });
    expect(mark).toEqual({
      state: 'failed',
      chat: '@KazaninaAE_AO',
      reason: 'CHAT_WRITE_FORBIDDEN',
    });
  });

  /** Успех важнее: пересылка могла упасть и уйти со второй попытки. */
  it('есть и время отправки, и старая ошибка — показываем отправку', () => {
    expect(describeAutoForward(sent({ auto_forward_error: 'таймаут' }))?.state).toBe('sent');
  });
});

describe('autoForwardWarning', () => {
  it('пересылки не было — предупреждать не о чем', () => {
    expect(autoForwardWarning({})).toBeNull();
  });

  it('ушла — предупреждаем о задвоении, с чатом и временем', () => {
    const msg = autoForwardWarning(sent(), '12.08.2026 18:26');
    expect(msg).toContain('уже ушёл менеджеру автоматически');
    expect(msg).toContain('@KazaninaAE_AO');
    expect(msg).toContain('12.08.2026 18:26');
    expect(msg).toContain('задвоит');
  });

  it('без времени — предупреждение всё равно есть', () => {
    expect(autoForwardWarning(sent({ auto_forward_chat: null }))).toContain('уже ушёл менеджеру');
  });

  /**
   * Упавшая автопересылка до менеджера не дошла — задваивать нечего, и
   * предупреждение только отговорило бы оператора передать лида руками.
   */
  it('не ушла — не предупреждаем', () => {
    expect(autoForwardWarning({
      auto_forwarded_at: null,
      auto_forward_error: 'CHAT_WRITE_FORBIDDEN',
    })).toBeNull();
  });
});
