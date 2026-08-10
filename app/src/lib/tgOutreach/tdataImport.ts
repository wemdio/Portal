import { readTdataArchive, type TdataArchiveItem } from '@/lib/telegram/tdataArchive';

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
 */
export async function collectTdataCandidates(
  uploads: TdataUpload[],
  read: TdataArchiveReader = readTdataArchive,
): Promise<TdataCollectResult> {
  const candidates: TdataCandidate[] = [];
  const skipped: TdataSkip[] = [];
  const errors: TdataError[] = [];
  const seen = new Map<number, string>();

  for (const upload of uploads) {
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
  tg_user_id: number;
  campaign_name: string | null;
}

/**
 * Развести кандидатов на новых и уже загруженных.
 *
 * Сверка идёт по всей базе, а не по текущей кампании: один ключ авторизации в
 * двух кампаниях — это два параллельных подключения и `AUTH_KEY_DUPLICATED`,
 * после которого Telegram рвёт сессию.
 */
export function splitExistingAccounts(
  candidates: TdataCandidate[],
  existing: ExistingAccountRow[],
): { fresh: TdataCandidate[]; skipped: TdataSkip[] } {
  const byUserId = new Map(existing.map((row) => [row.tg_user_id, row.campaign_name]));
  const fresh: TdataCandidate[] = [];
  const skipped: TdataSkip[] = [];

  for (const candidate of candidates) {
    if (!byUserId.has(candidate.tgUserId)) {
      fresh.push(candidate);
      continue;
    }
    const campaignName = byUserId.get(candidate.tgUserId);
    skipped.push({
      name: candidate.name,
      reason: campaignName
        ? `уже загружен в кампанию «${campaignName}»`
        : 'уже загружен в другую кампанию',
    });
  }

  return { fresh, skipped };
}
