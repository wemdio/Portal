/**
 * @jest-environment node
 *
 * Контракты общего модуля nameCleanupProtocol — единого протокола AI-очистки
 * названий для base-constructor, /api/cleanup-names, DFYB и tg-агента.
 *
 * Базовые контракты парсеров закреплены в processingStepsCleanupParse*.test.ts
 * (через re-export из processingSteps — исторический дом). Здесь — то, что
 * добавилось при унификации 04.07.2026:
 *   - снятие литеральных спецтокенов модели (<|eos|> и т.п.) — реальный кейс
 *     со скрина специалиста: «Бурятмяс<|eos|>» записался в базу;
 *   - buildCleanupUserMessage — форма входного сообщения протокола.
 */

import {
  buildCleanupUserMessage,
  parseCleanupResponse,
  parseCleanupResponseJson,
  stripModelArtifacts,
  stripNumberPrefix,
  CLEANUP_BATCH,
} from '@/lib/nameCleanupProtocol';

describe('stripModelArtifacts', () => {
  it('removes literal special tokens leaked by degraded models', () => {
    expect(stripModelArtifacts('Бурятмяс<|eos|>')).toBe('Бурятмяс');
    expect(stripModelArtifacts('Acme<|im_end|>')).toBe('Acme');
    expect(stripModelArtifacts('Acme</s>')).toBe('Acme');
    expect(stripModelArtifacts('<s>Acme')).toBe('Acme');
    expect(stripModelArtifacts('Acme<eos>')).toBe('Acme');
    expect(stripModelArtifacts('Acme<end_of_turn>')).toBe('Acme');
  });

  it('removes DeepSeek fullwidth-pipe tokens (U+FF5C)', () => {
    expect(stripModelArtifacts('Бурятмяс<｜end▁of▁sentence｜>')).toBe('Бурятмяс');
    expect(stripModelArtifacts('Acme<｜EOS｜>')).toBe('Acme');
  });

  it('keeps legitimate angle-bracket/pipe content intact', () => {
    // «|» в названии — легитимно (разделитель уже удаляет промпт, но парсер
    // не должен резать сам): токен-паттерн требует <| ... |>.
    expect(stripModelArtifacts('Johnson & Johnson')).toBe('Johnson & Johnson');
    expect(stripModelArtifacts('A|B Group')).toBe('A|B Group');
    expect(stripModelArtifacts('<Компания>')).toBe('<Компания>');
  });
});

describe('parseCleanupResponse — санация спецтокенов (кейс скрина 04.07)', () => {
  it('strips <|eos|> glued to a numbered line', () => {
    const content = '1. Роден\n2. Стюард\n10. Бурятмяс<|eos|>';
    const result = parseCleanupResponse(content, 3);
    expect(result!.get(10)).toBe('Бурятмяс');
  });

  it('positional fallback strips both prefixes and artifacts', () => {
    // Нумерация сломана (все строки «10.») → positional. Раньше сырые строки
    // с префиксами шли в БД — теперь чистые.
    const content = '10. Alpha\n10. Beta<|eos|>\n10. Gamma';
    const result = parseCleanupResponse(content, 5); // 1/5 < 80%
    expect(result!.get(1)).toBe('Alpha');
    expect(result!.get(2)).toBe('Beta');
    expect(result!.get(3)).toBe('Gamma');
  });

  it('a line that is ONLY an artifact is dropped, not written', () => {
    const content = '1. Alpha\n<|eos|>';
    const result = parseCleanupResponse(content, 1);
    expect(result!.get(1)).toBe('Alpha');
    expect(result!.size).toBe(1);
  });

  it('artifact-only line keeps its position in positional fallback (no shift)', () => {
    // Ненумерованный ответ: строка 2 — голый спецтокен. Позиции строк 3+ не
    // должны съехать вверх (иначе компании получают чужие названия).
    const content = 'Alpha\n<|eos|>\nGamma\nDelta';
    const result = parseCleanupResponse(content, 4);
    expect(result!.get(1)).toBe('Alpha');
    expect(result!.has(2)).toBe(false); // мусорная строка — оригинал останется
    expect(result!.get(3)).toBe('Gamma');
    expect(result!.get(4)).toBe('Delta');
  });

  it('returns null when the response is nothing but artifacts', () => {
    expect(parseCleanupResponse('<|eos|>\n<|eos|>', 2)).toBeNull();
  });
});

describe('parseCleanupResponse — нормализация 0-based нумерации', () => {
  it('shifts 0-based numbered echo (model mirrored JSON idx) to 1-based keys', () => {
    // Модель проигнорировала json_object и эхом вернула 0-based idx из
    // JSON-промпта. Без сдвига get(i+1) раздал бы всем компаниям чужие имена.
    const content = '0. Alpha\n1. Beta\n2. Gamma';
    const result = parseCleanupResponse(content, 3);
    expect(result!.get(1)).toBe('Alpha');
    expect(result!.get(2)).toBe('Beta');
    expect(result!.get(3)).toBe('Gamma');
    expect(result!.has(0)).toBe(false);
  });

  it('does NOT shift honest 1-based numbering', () => {
    const content = '1. Alpha\n2. Beta\n3. Gamma';
    const result = parseCleanupResponse(content, 3);
    expect(result!.get(1)).toBe('Alpha');
    expect(result!.get(3)).toBe('Gamma');
  });

  it('shifts partial 0-based response correctly', () => {
    // 0-based, но ответ неполный (0..3 из 5): ключ 0 есть, ключа 5 нет → сдвиг.
    const content = '0. Alpha\n1. Beta\n2. Gamma\n3. Delta';
    const result = parseCleanupResponse(content, 5);
    expect(result!.get(1)).toBe('Alpha');
    expect(result!.get(4)).toBe('Delta');
    expect(result!.has(0)).toBe(false);
    expect(result!.has(5)).toBe(false);
  });
});

describe('parseCleanupResponseJson — санация спецтокенов', () => {
  it('strips artifacts inside JSON names', () => {
    const content = JSON.stringify({
      cleaned: [
        { idx: 0, name: 'Бурятмяс<|eos|>' },
        { idx: 1, name: '1. Роден<|im_end|>' },
      ],
    });
    const result = parseCleanupResponseJson(content);
    expect(result!.get(1)).toBe('Бурятмяс');
    expect(result!.get(2)).toBe('Роден');
  });

  it('strips artifacts in truncation-salvage path too', () => {
    const content = '{"cleaned":[{"idx":0,"name":"Acme<|eos|>"},{"idx":1,"na';
    const result = parseCleanupResponseJson(content);
    expect(result!.get(1)).toBe('Acme');
    expect(result!.size).toBe(1);
  });
});

describe('stripNumberPrefix (re-export from protocol module)', () => {
  it('greedily strips stacked prefixes', () => {
    expect(stripNumberPrefix('35. 10. ПК ЗВМП')).toBe('ПК ЗВМП');
    expect(stripNumberPrefix('1) Acme')).toBe('Acme');
  });
});

describe('buildCleanupUserMessage', () => {
  it('produces {"companies":[{idx,name,domain?}]} with 0-based idx', () => {
    const msg = buildCleanupUserMessage([
      { name: 'Acme', domain: 'acme.ru' },
      { name: 'Beta' },
      { name: 'Gamma', domain: null },
    ]);
    expect(JSON.parse(msg)).toEqual({
      companies: [
        { idx: 0, name: 'Acme', domain: 'acme.ru' },
        { idx: 1, name: 'Beta' },
        { idx: 2, name: 'Gamma' },
      ],
    });
  });

  it('empty/undefined name becomes empty string (row keeps original downstream)', () => {
    const msg = buildCleanupUserMessage([{ name: '' }]);
    expect(JSON.parse(msg)).toEqual({ companies: [{ idx: 0, name: '' }] });
  });
});

describe('CLEANUP_BATCH', () => {
  it('is 50 — модель обрывала JSON на батчах в 100', () => {
    expect(CLEANUP_BATCH).toBe(50);
  });
});
