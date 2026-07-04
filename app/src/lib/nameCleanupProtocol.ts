/**
 * Единый протокол AI-очистки названий компаний (JSON-mode) + парсеры ответа.
 *
 * История: логика жила внутри processingSteps.ts (base-constructor) и была
 * скопипащена в /api/cleanup-names, dfybWorker и telegramAgent/cleanNames.
 * Фиксы багов «N. » префиксов (051c7d83d), JSON-mode (64e43e7f4) и обрыва
 * ответа (ccee3c038) попали только в оригинал — копии продолжали портить
 * данные (жалоба специалиста 04.07: «добавляются числа, либо название никак
 * не очищается»). Теперь все четыре потребителя импортируют ЭТОТ модуль.
 *
 * Модуль намеренно без тяжёлых зависимостей: его импортирует и API-роут
 * (companyNameCleanupBatch грузит processingSteps динамически именно потому,
 * что тот тянет весь base-constructor фреймворк — сюда это не тащим).
 */

export const CLEANUP_JSON_SYSTEM_PROMPT = `Ты очищаешь названия компаний для использования в персонализированных email-письмах.

Правила очистки:
1. Оставь только само название (2-3 слова максимум)
2. Удали: Inc, Ltd, Corp, LLC, ООО, ИП, АО, ЗАО, GmbH и т.п.
3. Удали текст после: -, |, /, ,, :
4. Удали текст в скобках
5. Удали символы: ®, ™, ©, #, !, ?
6. Если >3 слов — сделай аббревиатуру (если уместно)
7. Если всё КАПСОМ (6+ букв) — преобразуй в Title Case
8. Результат должен красиво звучать в предложении: "Я заметил что КОМПАНИЯ..."

ФОРМАТ ВВОДА: JSON-объект {"companies": [{"idx": 0, "name": "...", "domain": "..."?}, ...]}
ФОРМАТ ОТВЕТА: только JSON-объект {"cleaned": [{"idx": 0, "name": "очищенное"}, ...]}.
Каждому idx из ввода должен соответствовать ровно один элемент в cleaned с тем же idx.
Если не знаешь как очистить — верни оригинальное name. НИКОГДА не пропускай элементы.
Никаких пояснений, никаких markdown-обёрток вокруг JSON.`;

// 50, не 100: на батче в 100 компаний модель упиралась в лимит выходных
// токенов и ОБРЫВАЛА JSON на полпути (~55 из 100) → невалидный JSON →
// парсер падал, а text-fallback писал сырой блоб в ячейку. Меньший батч с
// запасом влезает в ответ. parseCleanupResponseJson дополнительно умеет
// доставать элементы из оборванного ответа (truncation salvage).
// Масштабный тест 04.07 (2000 имён): и с хорошей моделью текстовый протокол
// на батчах 100 сбивал нумерацию в ~20% батчей — 50+JSON обязательны.
export const CLEANUP_BATCH = 50;

export type CleanupEntry = { name: string; domain?: string | null };

/**
 * Входное сообщение протокола: {"companies":[{"idx":0,"name":"...","domain":"..."?}]}.
 * idx 0-based (парсер транслирует в 1-based ключи map'а при возврате).
 */
export function buildCleanupUserMessage(entries: CleanupEntry[]): string {
  const companies = entries.map((e, i) => {
    const obj: Record<string, unknown> = { idx: i, name: e.name || '' };
    if (e.domain) obj.domain = e.domain;
    return obj;
  });
  return JSON.stringify({ companies });
}

/**
 * Стрипает префиксы вида «N.», «N)» с начала строки, и так до упора.
 *
 * Зачем жадно: AI'а мы просим вернуть строки вида "{N}. Очищенное Название",
 * но модель регулярно глючит:
 *   - повторяет один номер для всех строк подряд (10. A, 10. B, 10. C);
 *   - оборачивает оригинальное «10. ПК ЗВМП» во внешний нумер и возвращает
 *     «1. 10. ПК ЗВМП» — внешний номер мы должны убрать, но внутренний
 *     тоже мусор для финальной базы;
 *   - в positional-fallback'е (когда <80% строк нумерованы) раньше префикс
 *     вообще не стрипался и пролезал в БД (жалоба специалиста: «в рандомных
 *     компаниях цифры в начале»).
 *
 * Trade-off: имя типа «1.5 кг» с точкой превратится в «5 кг», «12. серия»
 * → «серия». В B2B-базе названий компаний такое почти не встречается,
 * принимаем как осознанный риск ради устранения регресса с цифрами.
 *
 * Лимит на 5 итераций — защита от теоретической бесконечности; на практике
 * двух хватает («35. 10. ПК ЗВМП» → «10. ПК ЗВМП» → «ПК ЗВМП»).
 *
 * Применяется и в JSON-режиме (на случай если AI вшил префикс в name),
 * и в legacy text-fallback'е.
 */
const NUMBER_PREFIX_RE = /^(\d+)[.)]\s*/;
export function stripNumberPrefix(s: string): string {
  let out = s;
  for (let i = 0; i < 5; i += 1) {
    const next = out.replace(NUMBER_PREFIX_RE, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Литеральные спецтокены модели, протёкшие в текст ответа: <|eos|>,
 * <|im_end|>, </s>, <eos> и т.п. Реальный кейс со скрина специалиста
 * 04.07: «Бурятмяс<|eos|>» записался в базу как название компании
 * (деградировавшая модель за policy/cleanup эмитила EOS текстом).
 * Санитизируем в обоих парсерах — это никогда не легитимная часть названия.
 *
 * [|｜] — и ASCII pipe, и FULLWIDTH VERTICAL LINE U+FF5C: DeepSeek-семейство
 * (наблюдаемый роутинг Requesty policy/* алиасов) эмитит токены в fullwidth
 * форме «<｜end▁of▁sentence｜>».
 */
const MODEL_ARTIFACT_RE = /<[|｜][^|｜<>]*[|｜]>|<\/?s>|<eos>|<end_of_turn>/gi;
export function stripModelArtifacts(s: string): string {
  return s.replace(MODEL_ARTIFACT_RE, '').trim();
}

/** Полная санация имени из ответа модели: спецтокены + нумерация + trim. */
function sanitizeName(s: string): string {
  return stripNumberPrefix(stripModelArtifacts(s.trim()));
}

/**
 * Основной парсер (JSON-mode).
 *
 * Зачем: text-парсер исторически разбирался регэкспами по нумерованному
 * списку, и когда AI терялся в нумерации (повторял один номер для всей
 * пачки), парсер скатывался в positional fallback и пропускал «N. » префикс
 * в БД. С JSON-mode (response_format: json_object) модель обязана вернуть
 * валидный JSON со структурой {cleaned: [{idx, name}, ...]} — никаких
 * парсингов строк, никакого fallback'а нужно.
 *
 * Robust: salvage из markdown-блока ```json ...``` если модель проигнорировала
 * response_format и завернула; пропуск элементов без idx/name; финальный
 * sanitizeName на name как safety-net (вдруг AI вшил «1. » или спецтокен
 * внутрь name'а).
 *
 * Возвращает null если JSON вовсе не достали — caller тогда упадёт
 * на text-парсер как fallback.
 */
export function parseCleanupResponseJson(
  content: string,
): Map<number, string> | null {
  let parsed: unknown = null;
  // 1) Прямой JSON.parse.
  try {
    parsed = JSON.parse(content);
  } catch {
    // 2) Salvage: модель завернула в markdown ```json ...```.
    const codeBlock = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) {
      try { parsed = JSON.parse(codeBlock[1].trim()); } catch { /* fallthrough */ }
    }
    // 3) Salvage: вырезаем по самым внешним { ... }.
    if (parsed === null) {
      const objMatch = content.match(/\{[\s\S]*\}/);
      if (objMatch) {
        try { parsed = JSON.parse(objMatch[0]); } catch { /* fallthrough */ }
      }
    }
  }

  const cleaned =
    parsed && typeof parsed === 'object'
      ? (parsed as { cleaned?: unknown }).cleaned
      : null;

  if (Array.isArray(cleaned)) {
    // idx в JSON — 0-based (натурально для разработчика), а в map ключи 1-based
    // (так лукапит существующий stepNameCleanup: cleanedMap.get(i + 1)).
    // Транслируем idx → idx+1 при записи.
    const result = new Map<number, string>();
    for (const item of cleaned) {
      if (!item || typeof item !== 'object') continue;
      const { idx, name } = item as { idx?: unknown; name?: unknown };
      if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) continue;
      if (typeof name !== 'string') continue;
      const trimmed = name.trim();
      if (!trimmed) continue;
      const stripped = sanitizeName(trimmed);
      if (stripped) result.set(idx + 1, stripped);
    }
    if (result.size > 0) return result;
  }

  // 4) Truncation salvage. Модель часто ОБРЫВАЕТ ответ на полпути (упирается в
  //    лимит выходных токенов на батче), валидного JSON нет вовсе, и шаги 1-3
  //    дают null. Достаём по отдельности все ПОЛНОСТЬЮ закрытые пары
  //    "idx":N,"name":"...", восстанавливая префикс до точки обрыва. Без этого
  //    весь батч терялся, а text-fallback писал сырой JSON-блоб в ячейку
  //    «компания» (баг, видимый в выгрузке клиента 17.06).
  const salvaged = new Map<number, string>();
  const ITEM_RE = /"idx"\s*:\s*(\d+)\s*,\s*"name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = ITEM_RE.exec(content)) !== null) {
    const idx = Number(m[1]);
    if (!Number.isInteger(idx) || idx < 0) continue;
    let name = m[2];
    try { name = JSON.parse(`"${name}"`) as string; } catch { /* оставляем сырой */ }
    const stripped = sanitizeName(name.trim());
    if (stripped) salvaged.set(idx + 1, stripped);
  }
  return salvaged.size > 0 ? salvaged : null;
}

/**
 * Legacy text-парсер (fallback).
 *
 * Два режима:
 *   1. Strict numbered — если >=80% строк имеют префикс «N.», используем
 *      его как ключ. Робастно к перестановкам, пропускам, лишним строкам
 *      типа «Очищенные названия:».
 *   2. Positional fallback — если префиксов мало (модель забыла нумеровать,
 *      или повторила один номер для всех строк), выстраиваем строки по
 *      позиции i → row i+1. Здесь критично ВСЁ ЖЕ стрипать префиксы — иначе
 *      мусор типа «10. ПК ЗВМП» пролезет в БД как есть (это и был баг).
 *
 * После перехода на JSON-mode (parseCleanupResponseJson выше) этот парсер
 * остался как страховка на случай если модель проигнорировала
 * response_format: json_object и вернула старый текстовый формат.
 *
 * Возвращает null если ответ пустой.
 */
export function parseCleanupResponse(
  content: string,
  expectedCount: number,
): Map<number, string> | null {
  const numbered = new Map<number, string>();
  const cleanLines: string[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const noArtifacts = stripModelArtifacts(trimmed);
    const numMatch = noArtifacts.match(NUMBER_PREFIX_RE);
    const cleaned = stripNumberPrefix(noArtifacts);
    if (!cleaned) {
      // Строка целиком из спецтокена («<|eos|>») — placeholder, чтобы НЕ
      // сдвигать позиции в positional fallback (строка была в ответе, просто
      // мусорная). Строка из одного префикса («10. ») — мусор, как в HEAD.
      if (noArtifacts !== trimmed) cleanLines.push('');
      continue;
    }
    if (numMatch) numbered.set(parseInt(numMatch[1], 10), cleaned);
    cleanLines.push(cleaned);
  }
  if (cleanLines.length === 0 || cleanLines.every((l) => !l)) return null;
  if (numbered.size >= expectedCount * 0.8) {
    // JSON-промпт показывает модели 0-based idx. Если модель проигнорировала
    // response_format и эхом вернула нумерованный текст «0. …\n1. …», ключи
    // получились 0-based, а ВСЕ потребители лукапят get(i+1) (1-based) —
    // без нормализации весь суб-батч молча сдвинулся бы на одну строку
    // (компания А получила бы имя компании Б). Детект: есть ключ 0 и нет
    // ключа expectedCount (при честной 1-based нумерации нуля не бывает).
    if (numbered.has(0) && !numbered.has(expectedCount)) {
      const shifted = new Map<number, string>();
      for (const [k, v] of numbered) shifted.set(k + 1, v);
      return shifted;
    }
    return numbered;
  }
  // Positional fallback. Логируем, чтобы по jobId можно было искать
  // «cleanup упал в fallback» — индикатор что модель отвечает плохо
  // и стоит дробить батчи или менять prompt.
  console.warn(
    `[name-cleanup] cleanup positional fallback: only ${numbered.size}/${expectedCount} lines numbered`,
  );
  const positional = new Map<number, string>();
  for (let j = 0; j < cleanLines.length && j < expectedCount; j += 1) {
    const line = cleanLines[j];
    // Защита от порчи данных: строки, похожие на JSON ({…}/[…]) или аномально
    // длинные (>120) — это почти наверняка сырой ответ модели, а не название
    // компании. Раньше такой блоб целиком писался в ячейку «компания».
    if (line && line.length <= 120 && !/^[[{]/.test(line)) positional.set(j + 1, line);
  }
  return positional;
}
