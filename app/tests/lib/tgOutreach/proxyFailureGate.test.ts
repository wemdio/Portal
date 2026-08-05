/** @jest-environment node */

/**
 * Ворота автосвапа: по какой ошибке подключения менять прокси, а по какой — нет.
 *
 * Ошибиться можно в обе стороны, и обе дорогие. Пропустим сетевой сбой — мёртвый
 * модем останется у аккаунта, и оператор снова будет искать его глазами в логах.
 * Свапнем на проблеме сессии — сожжём живой прокси из пула впустую, потому что
 * AUTH_KEY_DUPLICATED сменой IP не лечится.
 */

import { looksLikeProxyFailure } from '@/lib/tgOutreach/gramClient';

describe('looksLikeProxyFailure', () => {
  it('сетевые сбои — свапаем', () => {
    for (const msg of [
      'connect timeout (30s)',
      'Timeout',
      'connect ECONNREFUSED 103.152.136.70:10018',
      'read ECONNRESET',
      'connect EHOSTUNREACH',
      'socket hang up',
    ]) {
      expect(looksLikeProxyFailure(msg)).toBe(true);
    }
  });

  it('проблемы сессии и прочее — не свапаем', () => {
    for (const msg of [
      '406: AUTH_KEY_DUPLICATED (caused by GetUsersRequest)',
      'AUTH_KEY_UNREGISTERED',
      'SESSION_REVOKED',
      'Нет session_data или session_file_path',
      'FLOOD_WAIT_420',
      '',
    ]) {
      expect(looksLikeProxyFailure(msg)).toBe(false);
    }
  });

  it('регистр не важен — gramJS пишет ошибки как придётся', () => {
    expect(looksLikeProxyFailure('CONNECT TIMEOUT (30s)')).toBe(true);
    expect(looksLikeProxyFailure('Socket Hang Up')).toBe(true);
  });
});
