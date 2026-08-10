/**
 * @jest-environment node
 */
import { StringSession } from 'telegram/sessions';
import { buildGramJsSessionString } from '@/lib/telegram/sessionUtils';

describe('buildGramJsSessionString', () => {
  it('строит строку, которую GramJS разбирает обратно', async () => {
    const authKey = Buffer.alloc(256, 42);
    const str = buildGramJsSessionString(2, '149.154.167.41', 443, authKey);

    // 352 символа после префикса версии — ветка «телетоновского» формата в GramJS
    expect(str.startsWith('1')).toBe(true);
    expect(str).toHaveLength(353);

    const session = new StringSession(str);
    await session.load();
    expect(session.dcId).toBe(2);
    expect(session.serverAddress).toBe('149.154.167.41');
    expect(session.port).toBe(443);
  });

  it('принимает Uint8Array так же, как Buffer', () => {
    const fromBuffer = buildGramJsSessionString(2, '149.154.167.41', 443, Buffer.alloc(256, 1));
    const fromU8 = buildGramJsSessionString(2, '149.154.167.41', 443, new Uint8Array(256).fill(1));
    expect(fromU8).toBe(fromBuffer);
  });
});
