/** @jest-environment node */

/**
 * Разбор итогов проверки аккаунта.
 *
 * Эта функция отвечает на вопрос, вокруг которого крутится всё расследование
 * августа 2026: аккаунт разлогинили или забанили? За две недели ~50 аккаунтов
 * потеряли сессии при нуле банов, и различает эти случаи только текст ошибки.
 * Перепутать их — значит списать живой аккаунт или искать несуществующий бан.
 */

import { classifyCheckError, describeSessions, resetOtherSessions, describeResetError } from '@/lib/tgOutreach/accountCheck';

describe('разбор ошибок проверки', () => {
  it('бан номера отличается от отзыва сессии', () => {
    expect(classifyCheckError('USER_DEACTIVATED_BAN').status).toBe('banned');
    expect(classifyCheckError('SESSION_REVOKED (401)').status).toBe('session_revoked');
  });

  it('бан важнее сетевой ошибки, даже если в тексте есть и то и другое', () => {
    // Реальный случай: соединение отвалилось уже после ответа Telegram о бане.
    expect(classifyCheckError('USER_DEACTIVATED_BAN after connect timeout').status).toBe('banned');
  });

  it('все формы «сессии больше нет» дают один итог', () => {
    for (const msg of [
      'SESSION_REVOKED',
      'AUTH_KEY_UNREGISTERED',
      'AUTH_KEY_INVALID',
      'SESSION_EXPIRED',
    ]) {
      expect(classifyCheckError(msg).status).toBe('session_revoked');
    }
  });

  it('чужой вход выделен отдельно: аккаунт жив, но в нём кто-то есть', () => {
    const res = classifyCheckError('406: AUTH_KEY_DUPLICATED');
    expect(res.status).toBe('session_duplicate');
    expect(res.detail).toMatch(/другого устройства/);
  });

  it('сетевые сбои не путаем с проблемами аккаунта', () => {
    for (const msg of ['connect timeout (30s)', 'ECONNRESET', 'socket hang up', 'getMe: нет ответа за 30с']) {
      expect(classifyCheckError(msg).status).toBe('proxy_dead');
    }
  });

  it('незнакомая ошибка не выдаёт себя за диагноз', () => {
    const res = classifyCheckError('INTERNAL_SERVER_ERROR');
    expect(res.status).toBe('error');
    expect(res.detail).toBe('INTERNAL_SERVER_ERROR');
  });
});

describe('список чужих сеансов', () => {
  function auth(fields: Record<string, unknown>) {
    return {
      current: false,
      deviceModel: 'PC',
      platform: 'Windows',
      appName: 'Telegram Desktop',
      appVersion: '4.0',
      country: 'Kazakhstan',
      ip: '1.2.3.4',
      dateCreated: 1786000000,
      dateActive: 1786086010,
      ...fields,
    };
  }

  it('свой сеанс из списка исключается — иначе портал считал бы себя чужим', () => {
    const sessions = describeSessions({
      authorizations: [auth({ current: true }), auth({})],
    } as never);
    expect(sessions).toHaveLength(1);
  });

  it('отдаёт то, по чему опознают гостя: устройство, приложение, страну, время', () => {
    const [s] = describeSessions({ authorizations: [auth({})] } as never);
    expect(s).toMatchObject({
      device: 'PC',
      platform: 'Windows',
      app: 'Telegram Desktop 4.0',
      country: 'Kazakhstan',
      ip: '1.2.3.4',
    });
    expect(new Date(s.last_active).getTime()).toBe(1786086010 * 1000);
  });

  it('пустые поля не превращаются в пустые строки в интерфейсе', () => {
    const [s] = describeSessions({
      authorizations: [auth({ deviceModel: '', country: '', appName: '', appVersion: '' })],
    } as never);
    expect(s.device).toBe('—');
    expect(s.country).toBe('—');
    expect(s.app).toBe('—');
  });
});

describe('сброс чужих сеансов', () => {
  it('зовёт Telegram один раз и не переподключается', async () => {
    const invoke = jest.fn(async () => ({}));
    await resetOtherSessions({ invoke } as never);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('пробрасывает отказ наверх, а не глотает его', async () => {
    const invoke = jest.fn(async () => { throw new Error('FRESH_RESET_AUTHORISATION_FORBIDDEN'); });
    await expect(resetOtherSessions({ invoke } as never)).rejects.toThrow(/FRESH_RESET/);
  });

  it('объясняет защиту Telegram для свежей сессии', () => {
    // Самый частый исход на только что залитой партии: сбросить чужие сеансы
    // можно лишь через сутки после первого входа.
    expect(describeResetError(new Error('FRESH_RESET_AUTHORISATION_FORBIDDEN'))).toMatch(/24 часа/);
  });

  it('называет срок ожидания при FLOOD_WAIT', () => {
    expect(describeResetError(new Error('FLOOD_WAIT_600'))).toMatch(/600 секунд/);
  });

  it('про отозванную сессию говорит, что сбрасывать нечего', () => {
    expect(describeResetError(new Error('AUTH_KEY_UNREGISTERED'))).toMatch(/нечего/);
  });
});
