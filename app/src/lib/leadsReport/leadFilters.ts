/**
 * Текстовые фильтры сделок для отчёта продаж: чёрный список имён и
 * дедупликация лид-магнита.
 *
 * Живут отдельно от `metrics.ts` намеренно — тот уже отвечает за пороги
 * этапов, отчётное окно и запрос в БД. Здесь только чистые функции над
 * именами, без типов AMO и без Supabase.
 */

const normalizeName = (value: string | null): string =>
  (value ?? '')
    .trim()
    .toLocaleLowerCase('ru-RU')
    .replaceAll('ё', 'е')
    // Телеграм-имена приходят как есть — двойной пробел, таб или перевод
    // строки между словами не редкость. Без схлопывания «Юлия  Миронова»
    // (двойной пробел) не совпадёт с «Юлия Миронова» из списка.
    .replace(/\s+/g, ' ');

/**
 * Имена, которые никогда не считаются в отчёт — ни в «Пришло», ни в «Лидов»,
 * ни во встречи, ни в одном канале.
 *
 * Это свои люди, тестирующие бота и форму заявки, плюс явные тестовые прогоны.
 * За неделю 31.07–07.08 «Бот: Юлия Миронова» дал две сделки в SMM, обе
 * засчитались лидами. Список согласован с Дмитрием 10.08.2026 и действует во
 * всех каналах: заявка сотрудника может прилететь и через лид-магнит в
 * Маркетинг, не только через SMM.
 *
 * Список буквальный, без вариаций: каждая запись ловит только точное
 * написание (после нормализации регистра/«ё»/пробелов), а не человека вообще.
 * Если сделка придёт под другим именем — латиницей («Бот: Yulia Mironova»),
 * уменьшительным («Бот: Юля Миронова») или в обратном порядке
 * («Бот: Миронова Юлия») — ни одна запись её не поймает, нужно будет
 * добавить именно ту форму. «Егор Каныгин» — частный случай этого: в базе за
 * три месяца не встречается ни разу, строка оставлена по просьбе продаж; если
 * его заявки приходят под другим телеграм-именем, нужно добавить именно то
 * имя, а не полагаться на текущее.
 */
export const EXCLUDED_LEAD_NAMES: readonly string[] = [
  'Юлия Миронова',
  'Егор Каныгин',
  'Саша',
  'тест',
  'test',
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const normalizedExcluded = EXCLUDED_LEAD_NAMES.map(normalizeName);

// Пустая запись в списке (пустой литерал, строка из пробелов, случайная ''
// от кривой правки) даёт альтернации пустую ветку — паттерн вырождается в
// «совпадает почти с любой строкой, где есть подряд два не-буквенных символа
// или не-буква с краю» и молча обнуляет весь отчёт (проверено: список
// ['Саша', ''] ловит «Бот: Ольга» и «Заявка: romashka.ru» — то есть почти
// любую сделку, потому что почти каждое имя сделки содержит «: »). Проверяем
// при загрузке модуля и падаем громко: пусть воркер отчёта упадёт с
// TG-алертом, а не уйдёт отчёт с враньём — обнулённый отчёт неотличим от
// плохой недели, пока кто-то не заметит вручную.
if (normalizedExcluded.some((entry) => entry === '')) {
  throw new Error('EXCLUDED_LEAD_NAMES: пустая строка выключит отчёт целиком');
}

/**
 * Совпадение — по отдельному слову, а не по подстроке: иначе «Саша» поймала бы
 * «Сашанину», а «тест» — «протестирован». Границей считается всё, что не
 * буква — цифра границей тоже считается, поэтому `test.ru`, `test-direct-site`
 * и склеенные с цифрами без разделителя `ТЕСТ2026`/`test123.ru` тоже ловятся.
 */
const EXCLUDED_NAME_PATTERN = new RegExp(
  `(^|[^\\p{L}])(${normalizedExcluded
    .map(escapeRegExp)
    .join('|')})([^\\p{L}]|$)`,
  'u',
);

export function isExcludedLeadName(name: string | null): boolean {
  return EXCLUDED_NAME_PATTERN.test(normalizeName(name));
}

/**
 * Признак «лид-магнит»: сделка автоматически создана TG-ботом «Polza Site
 * Feedback» — имя всегда с префиксом «Бот:» (см. Telegram-канал заявок).
 */
export const LEAD_MAGNET_NAME_PREFIX = 'Бот:';

export function isLeadMagnet(name: string | null): boolean {
  return typeof name === 'string' && name.trimStart().startsWith(LEAD_MAGNET_NAME_PREFIX);
}

export type DedupCandidate = {
  amoId: number;
  name: string | null;
  /** Максимальный достигнутый этап — считается в `metrics.ts`. */
  peak: number;
  channel: string;
  createdAt: string | null;
};

/**
 * Схлопывает повторные заявки лид-магнита: одно имя внутри одного канала за
 * отчётное окно — одна сделка.
 *
 * Только лид-магнит. У заявок бота имя — это телеграм-аккаунт, совпадение
 * означает того же человека, ткнувшего бота дважды (за неделю 24.07 таких было
 * 11). У остальных сделок имя не гарантирует ничего: в Аутриче за неделю
 * 31.07–07.08 было два разных «Дмитрия», а под именем «Заявка с сайта» за
 * неделю 19.06 сидели 27 разных компаний. Дедуп по всем именам съел бы живые
 * лиды.
 *
 * Из группы остаётся сделка с наибольшим `peak`; при равенстве — самая ранняя
 * по `createdAt`; при равенстве — с меньшим `amoId`. Последнее нужно, чтобы
 * результат не зависел от порядка строк, в котором их отдала БД.
 */
export function dedupeLeadMagnets<T extends DedupCandidate>(candidates: T[]): T[] {
  const winnerByKey = new Map<string, T>();

  for (const candidate of candidates) {
    if (!isLeadMagnet(candidate.name)) continue;
    const key = `${candidate.channel} ${normalizeName(candidate.name)}`;
    const current = winnerByKey.get(key);
    if (!current || isBetterCandidate(candidate, current)) {
      winnerByKey.set(key, candidate);
    }
  }

  const winners = new Set(winnerByKey.values());
  return candidates.filter(
    (candidate) => !isLeadMagnet(candidate.name) || winners.has(candidate),
  );
}

function isBetterCandidate(candidate: DedupCandidate, current: DedupCandidate): boolean {
  if (candidate.peak !== current.peak) return candidate.peak > current.peak;

  const candidateTime = Date.parse(candidate.createdAt ?? '');
  const currentTime = Date.parse(current.createdAt ?? '');
  const candidateValid = Number.isFinite(candidateTime);
  const currentValid = Number.isFinite(currentTime);
  if (candidateValid && currentValid && candidateTime !== currentTime) {
    return candidateTime < currentTime;
  }
  if (candidateValid !== currentValid) return candidateValid;

  return candidate.amoId < current.amoId;
}
