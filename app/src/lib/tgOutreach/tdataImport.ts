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
        const name = i === 0 ? item.name : `${item.name}_${i + 1}`;

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
  const byUserId = new Map<number, string | null>();
  const byAuthKey = new Map<string, string | null>();

  for (const row of existing) {
    if (row.tg_user_id !== null && row.tg_user_id !== undefined) {
      byUserId.set(row.tg_user_id, row.campaign_name);
    }
    const fingerprint = authKeyFingerprint(row.session_data);
    if (fingerprint) byAuthKey.set(fingerprint, row.campaign_name);
  }

  const fresh: TdataCandidate[] = [];
  const skipped: TdataSkip[] = [];

  for (const candidate of candidates) {
    if (byUserId.has(candidate.tgUserId)) {
      const campaignName = byUserId.get(candidate.tgUserId);
      skipped.push({
        name: candidate.name,
        reason: campaignName
          ? `уже загружен в кампанию «${campaignName}»`
          : 'уже загружен в другую кампанию',
      });
      continue;
    }

    // Совпал только ключ: та же сессия лежит в базе под другим (или ещё не
    // выясненным) телеграм-id. Формулировка отличается намеренно — оператор
    // ищет её в списке по имени и не найдёт.
    const fingerprint = authKeyFingerprint(candidate.sessionString);
    if (fingerprint && byAuthKey.has(fingerprint)) {
      const campaignName = byAuthKey.get(fingerprint);
      skipped.push({
        name: candidate.name,
        reason: campaignName
          ? `эта же сессия уже загружена в кампанию «${campaignName}» — совпал ключ входа`
          : 'эта же сессия уже загружена в другую кампанию — совпал ключ входа',
      });
      continue;
    }

    fresh.push(candidate);
  }

  return { fresh, skipped };
}
