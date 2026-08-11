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

    // dc_id/адрес/порт могут совпасть и при испорченных байтах ключа — GramJS
    // их не проверяет, они просто лежат последними 256 байтами. Сверяем сами
    // байты ключа, а не только то, что StringSession не упал на разборе.
    const decoded = Buffer.from(str.slice(1), 'base64');
    expect(decoded.subarray(decoded.length - 256)).toEqual(authKey);
  });

  it('принимает Uint8Array так же, как Buffer', () => {
    const fromBuffer = buildGramJsSessionString(2, '149.154.167.41', 443, Buffer.alloc(256, 1));
    const fromU8 = buildGramJsSessionString(2, '149.154.167.41', 443, new Uint8Array(256).fill(1));
    expect(fromU8).toBe(fromBuffer);
  });

  it('бросает ошибку на слишком коротком ключе', () => {
    expect(() =>
      buildGramJsSessionString(2, '149.154.167.41', 443, Buffer.alloc(255, 1)),
    ).toThrow('255');
  });

  it('бросает ошибку на слишком длинном ключе', () => {
    expect(() =>
      buildGramJsSessionString(2, '149.154.167.41', 443, Buffer.alloc(257, 1)),
    ).toThrow('257');
  });
});
