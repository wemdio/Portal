/**
 * @jest-environment node
 */
import { StringSession } from 'telegram/sessions';
import { authKeyFingerprint, buildGramJsSessionString } from '@/lib/telegram/sessionUtils';

const key = (fill: number) => Buffer.alloc(256, fill);

describe('authKeyFingerprint', () => {
  it('не зависит от адреса DC, записанного перед ключом', () => {
    // Один и тот же аккаунт, загруженный двумя путями, получает разный адрес
    // DC: из tdata он берётся из таблицы mtcute, из .session — из SQLite.
    // Совпасть строки не обязаны, а ключ авторизации у них один и тот же.
    const fromTdata = buildGramJsSessionString(2, '149.154.167.41', 443, key(7));
    const fromSqlite = buildGramJsSessionString(2, '149.154.167.50', 443, key(7));

    expect(fromTdata).not.toBe(fromSqlite);
    expect(authKeyFingerprint(fromTdata)).toBe(authKeyFingerprint(fromSqlite));
  });

  it('совпадает у строки, прогнанной через StringSession (путь .session)', async () => {
    // Старый путь кладёт в session_data результат StringSession.save(), а не
    // ту строку, которую собрали мы. Если бы save() перекладывал байты иначе,
    // отпечатки двух путей загрузки разошлись бы, и сверка пропустила бы ровно
    // те строки, ради которых она и делается.
    const built = buildGramJsSessionString(2, '149.154.167.41', 443, key(11));
    const session = new StringSession(built);
    await session.load();

    expect(authKeyFingerprint(session.save())).toBe(authKeyFingerprint(built));
  });

  it('различает разные ключи', () => {
    const a = authKeyFingerprint(buildGramJsSessionString(2, '149.154.167.41', 443, key(7)));
    const b = authKeyFingerprint(buildGramJsSessionString(2, '149.154.167.41', 443, key(8)));

    expect(a).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it('достаёт ключ и из IPv6-строки, где адрес длиннее', () => {
    const v4 = buildGramJsSessionString(2, '149.154.167.41', 443, key(9));
    const v6 = buildGramJsSessionString(2, '2001:067c:04e8:f002:0000:0000:0000:000a', 443, key(9));

    expect(v6.length).toBeGreaterThan(v4.length);
    expect(authKeyFingerprint(v6)).toBe(authKeyFingerprint(v4));
  });

  it('на пустой и битой строке возвращает null, а не бросает', () => {
    // В таблице полно строк с session_data = '' — там, где конвертация упала.
    // Такая строка не должна совпасть ни с чем, в том числе с другой пустой.
    expect(authKeyFingerprint('')).toBeNull();
    expect(authKeyFingerprint(null)).toBeNull();
    expect(authKeyFingerprint(undefined)).toBeNull();
    expect(authKeyFingerprint(`1${Buffer.alloc(100).toString('base64')}`)).toBeNull();
    expect(authKeyFingerprint('совсем не base64')).toBeNull();
  });
});
