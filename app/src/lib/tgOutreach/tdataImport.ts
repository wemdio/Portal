import { readTdataArchive, type TdataArchiveItem } from '@/lib/telegram/tdataArchive';
import { authKeyFingerprint } from '@/lib/telegram/sessionUtils';

/**
 * Официальные ключи Telegram Desktop.
 *
 * Ключ авторизации в tdata выписан именно этим клиентом. Подставить сюда чужой
 * api_id — значит показать Telegram, что живой сессией десктопа вдруг начал
 * пользоваться посторонний софт; это ровно тот признак, по которому аккаунты
 * получают флаг.
 */
export const TDESKTOP_API_ID = 2040;
export const TDESKTOP_API_HASH = 'b18441a1ff607e10a989891a5462e627';

export interface TdataUpload {
  name: string;
  buffer: Buffer;
}

export interface TdataCandidate {
  name: string;
  tgUserId: number;
  sessionString: string;
  apiId: number;
  apiHash: string;
}

export interface TdataSkip {
  name: string;
  reason: string;
}

export interface TdataError {
  name: string;
  error: string;
}

export interface TdataCollectResult {
  candidates: TdataCandidate[];
  skipped: TdataSkip[];
  errors: TdataError[];
}

export type TdataArchiveReader = (
  buffer: Buffer,
  archiveName: string,
) => Promise<TdataArchiveItem[]>;

/**
 * Сделать имя уникальным в пределах загрузки.
 *
 * Слой архива называет папки честно, но одинаковые имена он отдаёт законно:
 * `лот1/acc/tdata` и `лот2/acc/tdata` — обычная раскладка продавца, и обе
 * папки называются `acc`. Ниже по цепочке это никто не заметит — дубли ищутся
 * по телеграм-id, а на `session_name` в базе нет уникального индекса, так что
 * строки лягут неразличимыми. Для tdata это больнее обычного: телефон пуст, а
 * имя пользователя неизвестно, пока по строке не сходит «Проверить», — имя
 * остаётся единственной зацепкой оператора.
 */
function uniqueName(name: string, used: Set<string>): string {
  let unique = name;
  for (let n = 2; used.has(unique); n++) unique = `${name}_${n}`;
  used.add(unique);
  return unique;
}

/**
 * Разобрать загруженные архивы в кандидатов на вставку.
 *
 * Дубли внутри самой загрузки отсекаются здесь; сверка с базой — на уровне
 * ручки, ей нужен доступ к Supabase. Ошибка одного архива не отменяет
 * остальные: оператор грузит партию целиком и должен увидеть, что именно
 * не прочиталось.
 *
 * Принимает и готовый массив, и асинхронную последовательность. Второе нужно
 * ручке: она подаёт архивы по одному, чтобы в памяти лежал текущий, а не вся
 * партия — в полной папке Telegram Desktop гигабайты кэша.
 */
export async function collectTdataCandidates(
  uploads: Iterable<TdataUpload> | AsyncIterable<TdataUpload>,
  read: TdataArchiveReader = readTdataArchive,
): Promise<TdataCollectResult> {
  const candidates: TdataCandidate[] = [];
  const skipped: TdataSkip[] = [];
  const errors: TdataError[] = [];
  const seen = new Map<number, string>();
  const usedNames = new Set<string>();

  for await (const upload of uploads) {
    let items: TdataArchiveItem[];
    try {
      items = await read(upload.buffer, upload.name);
    } catch (err) {
      errors.push({ name: upload.name, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    for (const item of items) {
      // Папка, которую не удалось прочитать: соседние папки того же архива
      // при этом загружаются — оператор грузит партию целиком.
      if (item.error) {
        errors.push({ name: item.name, error: item.error });
        continue;
      }

      for (let i = 0; i < item.accounts.length; i++) {
        const account = item.accounts[i];
        const name = uniqueName(i === 0 ? item.name : `${item.name}_${i + 1}`, usedNames);

        const already = seen.get(account.tgUserId);
        if (already) {
          skipped.push({ name, reason: `этот же аккаунт уже есть в загрузке (${already})` });
          continue;
        }
        seen.set(account.tgUserId, name);

        candidates.push({
          name,
          tgUserId: account.tgUserId,
          sessionString: account.sessionString,
          apiId: TDESKTOP_API_ID,
          apiHash: TDESKTOP_API_HASH,
        });
      }
    }
  }

  return { candidates, skipped, errors };
}

export interface ExistingAccountRow {
  /** Пуст у всех строк, по которым ещё не ходил getMe() — например у залитых `.session`. */
  tg_user_id: number | null;
  campaign_name: string | null;
  /** Пуст там, где конвертация в строку сессии не удалась. */
  session_data?: string | null;
  /** Под этим именем аккаунт лежит в списке кампании — по нему оператор его и ищет. */
  session_name?: string | null;
  phone?: string | null;
  tg_username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

/**
 * Как назвать оператору уже загруженный аккаунт, чтобы он нашёл его в списке.
 *
 * Порядок от самого полезного: `session_name` — это то, что видно в колонке
 * списка. Пустые поля пропускаем: у строк из tdata нет телефона до первой
 * проверки, у старых может не быть имени, и «— , , +7» читалось бы хуже, чем
 * одно название кампании.
 */
function describeExistingAccount(row: ExistingAccountRow): string {
  const username = (row.tg_username ?? '').trim().replace(/^@/, '');
  const fullName = [row.first_name, row.last_name]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join(' ');

  return [
    (row.session_name ?? '').trim(),
    fullName,
    username ? `@${username}` : '',
    (row.phone ?? '').trim(),
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * Причина пропуска: куда загружен, кто это и по какому признаку совпал.
 *
 * Названия кампании оператору мало — в ней десятки строк, и искать не по чему.
 * Признак совпадения оставляем в скобках: по `telegram-id` аккаунт видно в
 * списке сразу, а совпадение по ключу означает, что там он лежит под другим
 * или ещё не выясненным id.
 */
function skipReason(row: ExistingAccountRow, matched: 'id' | 'key'): string {
  const where = row.campaign_name ? `в кампанию «${row.campaign_name}»` : 'в другую кампанию';
  const who = describeExistingAccount(row);
  const why = matched === 'id' ? 'совпал telegram-id' : 'совпал ключ входа';

  return who ? `уже загружен ${where} — ${who} (${why})` : `уже загружен ${where} (${why})`;
}

/**
 * Развести кандидатов на новых и уже загруженных.
 *
 * Сверка идёт по всей базе, а не по текущей кампании: один ключ авторизации в
 * двух кампаниях — это два параллельных подключения и `AUTH_KEY_DUPLICATED`,
 * после которого Telegram рвёт сессию.
 *
 * Ключей сверки два, и второй обязателен. По `tg_user_id` не найдётся ничего
 * из того, что залито старым путём (`.session`): там колонка пуста, пока по
 * аккаунту не сходил getMe(). Именно эти строки оператор и перезальёт первым
 * делом — те же аккаунты, уже сконвертированные руками. Поэтому вторым ключом
 * идёт сам ключ авторизации: он есть в `session_data` у обоих путей загрузки и
 * одинаков у одной и той же сессии, какой бы адрес DC ни лежал перед ним.
 */
export function splitExistingAccounts(
  candidates: TdataCandidate[],
  existing: ExistingAccountRow[],
): { fresh: TdataCandidate[]; skipped: TdataSkip[] } {
  const byUserId = new Map<number, ExistingAccountRow>();
  const byAuthKey = new Map<string, ExistingAccountRow>();

  for (const row of existing) {
    if (row.tg_user_id !== null && row.tg_user_id !== undefined) {
      byUserId.set(row.tg_user_id, row);
    }
    const fingerprint = authKeyFingerprint(row.session_data);
    if (fingerprint) byAuthKey.set(fingerprint, row);
  }

  const fresh: TdataCandidate[] = [];
  const skipped: TdataSkip[] = [];

  for (const candidate of candidates) {
    const byId = byUserId.get(candidate.tgUserId);
    if (byId) {
      skipped.push({ name: candidate.name, reason: skipReason(byId, 'id') });
      continue;
    }

    // Совпал только ключ: та же сессия лежит в базе под другим или ещё не
    // выясненным телеграм-id, поэтому по id её найти было нельзя.
    const fingerprint = authKeyFingerprint(candidate.sessionString);
    const byKey = fingerprint ? byAuthKey.get(fingerprint) : undefined;
    if (byKey) {
      skipped.push({ name: candidate.name, reason: skipReason(byKey, 'key') });
      continue;
    }

    fresh.push(candidate);
  }

  return { fresh, skipped };
}
