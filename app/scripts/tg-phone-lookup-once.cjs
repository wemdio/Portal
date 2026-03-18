"use strict";

const path = require("node:path");
const process = require("node:process");
const os = require("node:os");
const fs = require("node:fs");

const xlsx = require("xlsx");
const { Client: PgClient } = require("pg");
const { createClient } = require("@supabase/supabase-js");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const SQLiteSession = require("gramjs-sqlitesession");

/**
 * @typedef {Object} PhoneRecord
 * @property {number} rowNo
 * @property {string} company
 * @property {string} sourceColumn
 * @property {string} sourceValue
 * @property {string} normalizedPhone
 */

/**
 * @typedef {Object} ProbeResult
 * @property {boolean} exists
 * @property {string} username
 * @property {string} link
 * @property {string} telegramId
 * @property {string} note
 */

const PHONE_COLUMN_RE = /(телефон|whatsapp|viber|telegram)/i;
const MOBILE_ONLY_COLUMN_RE = /мобильный/i;

function usage() {
  console.log(
    "Usage:\n" +
      "  node --env-file ../.env scripts/tg-phone-lookup-once.cjs <input.xlsx> [output.xlsx]\n\n" +
      "Example:\n" +
      '  node --env-file ../.env scripts/tg-phone-lookup-once.cjs "G:\\\\Загрузки\\\\поставщики.экспортбейс.xlsx"'
  );
}

function normalizePhone(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/t\.me\//i.test(raw) || raw.startsWith("@")) return null;

  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  if (digits.length === 11 && digits.startsWith("8")) return `+7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith("7")) return `+${digits}`;
  if (digits.length === 10) return `+7${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;

  return null;
}

function splitCellPhones(value) {
  return String(value ?? "")
    .split(/[\n,;|/]/g)
    .map((v) => v.trim())
    .filter(Boolean);
}

function collectPhoneRecords(rows) {
  /** @type {PhoneRecord[]} */
  const records = [];

  rows.forEach((row, index) => {
    const rowNo = index + 2;
    const company = String(row["Название компании"] ?? row["Company"] ?? "").trim();
    // Skip duplicated header rows occasionally present in exported datasets.
    if (/^название компании$/i.test(company)) return;
    const mobileOnly = process.env.TG_MOBILE_ONLY === "1";
    for (const [column, cellValue] of Object.entries(row)) {
      const columnMatch = mobileOnly
        ? MOBILE_ONLY_COLUMN_RE.test(String(column))
        : PHONE_COLUMN_RE.test(String(column));
      if (!columnMatch) continue;
      for (const part of splitCellPhones(cellValue)) {
        const normalizedPhone = normalizePhone(part);
        if (!normalizedPhone) continue;
        records.push({
          rowNo,
          company,
          sourceColumn: String(column),
          sourceValue: String(part),
          normalizedPhone,
        });
      }
    }
  });

  return records;
}

function expandWorksheetRefIfBroken(sheet) {
  const currentRef = String(sheet["!ref"] || "").trim();
  const cellKeys = Object.keys(sheet).filter((k) => /^[A-Z]+\d+$/.test(k));
  if (!cellKeys.length) return;

  let maxRow = 0;
  for (const key of cellKeys) {
    const row = Number(key.match(/\d+$/)[0]);
    if (row > maxRow) maxRow = row;
  }

  if (!maxRow) return;
  const declaredEndRow = currentRef.includes(":") ? Number(currentRef.split(":")[1].match(/\d+$/)?.[0] || 0) : 0;
  if (declaredEndRow >= maxRow) return;

  const maxCellRef = cellKeys.reduce((best, cell) => {
    const c = xlsx.utils.decode_cell(cell);
    const b = xlsx.utils.decode_cell(best);
    if (c.r > b.r) return cell;
    if (c.r === b.r && c.c > b.c) return cell;
    return best;
  }, "A1");
  sheet["!ref"] = `A1:${maxCellRef}`;
}

function chunk(array, size) {
  /** @type {any[][]} */
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadOutreachSessionFile(storagePath) {
  const supabaseUrl = String(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "").trim();
  const supabaseKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Не заданы NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY для загрузки .session файла");
  }
  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
  const { data, error } = await supabase.storage.from("tg-outreach-sessions").download(storagePath);
  if (error || !data) {
    throw new Error(`Не удалось скачать .session из storage: ${error?.message || "unknown error"}`);
  }
  const localPath = path.join(os.tmpdir(), `tg-outreach-${Date.now()}-${path.basename(storagePath)}`);
  fs.writeFileSync(localPath, Buffer.from(await data.arrayBuffer()));
  return localPath;
}

async function loadTelegramCredentials() {
  const forcedSessionFilePath = String(process.env.TG_FORCE_OUTREACH_SESSION_PATH || "").trim();
  if (forcedSessionFilePath) {
    const apiId = Number(
      process.env.TG_FORCE_API_ID || process.env.TG_API_ID || process.env.TELEGRAM_API_ID || "0"
    );
    const apiHash = String(
      process.env.TG_FORCE_API_HASH || process.env.TG_API_HASH || process.env.TELEGRAM_API_HASH || ""
    ).trim();
    if (!apiId || !apiHash) {
      throw new Error("Для TG_FORCE_OUTREACH_SESSION_PATH нужны TG_FORCE_API_ID и TG_FORCE_API_HASH");
    }
    const localSessionPath = await downloadOutreachSessionFile(forcedSessionFilePath);
    return {
      apiId,
      apiHash,
      sessionKind: "sqlite_file",
      sessionValue: localSessionPath,
      source: "env:TG_FORCE_OUTREACH_SESSION_PATH",
    };
  }

  const envApiId = Number(process.env.TGPARS_API_ID || process.env.TELEGRAM_API_ID || "0");
  const envApiHash = String(process.env.TGPARS_API_HASH || process.env.TELEGRAM_API_HASH || "").trim();
  const envSession = String(process.env.TGPARS_SESSION_STRING || "").trim();
  if (envApiId && envApiHash && envSession) {
    return {
      apiId: envApiId,
      apiHash: envApiHash,
      sessionKind: "string",
      sessionValue: envSession,
      source: "env",
    };
  }

  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) {
    throw new Error(
      "Нет полной Telegram-сессии в .env и отсутствует DATABASE_URL. Нужен TGPARS_SESSION_STRING или запись в tg_parser_accounts."
    );
  }

  const pg = new PgClient({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  try {
    const extractSessionString = (raw) => {
      const text = String(raw ?? "").trim();
      if (!text) return "";
      if (text.startsWith("{") || text.startsWith("\"")) {
        try {
          const parsed = JSON.parse(text);
          if (typeof parsed === "string") return parsed.trim();
          if (parsed && typeof parsed === "object" && typeof parsed.session_string === "string") {
            return parsed.session_string.trim();
          }
        } catch {
          // not JSON, return as-is below
        }
      }
      return text;
    };
    const extractPoolSession = (raw) => {
      const text = String(raw ?? "").trim();
      if (!text) return null;
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed === "string") {
          return { kind: "string", value: parsed.trim() };
        }
        if (parsed && typeof parsed === "object") {
          if (typeof parsed.session_string === "string" && parsed.session_string.trim()) {
            return { kind: "string", value: parsed.session_string.trim() };
          }
          if (typeof parsed.session_file_base64 === "string" && parsed.session_file_base64.trim()) {
            const tempPath = path.join(os.tmpdir(), `tg-phone-lookup-${Date.now()}.session`);
            fs.writeFileSync(tempPath, Buffer.from(parsed.session_file_base64, "base64"));
            return { kind: "sqlite_file", value: tempPath };
          }
        }
      } catch {
        // not json
      }
      return null;
    };

    const sources = [
      {
        name: "db:tg_parser_accounts",
        query: `
          select api_id, api_hash, session_data::text as session_data
          from tg_parser_accounts
          where is_active = true
            and coalesce(session_data::text, '') <> ''
          order by created_at desc
          limit 1
        `,
      },
      {
        name: "db:tg_outreach_accounts",
        query: `
          select api_id, api_hash, session_data::text as session_data, session_file_path
          from tg_outreach_accounts
          where is_active = true
            and (
              coalesce(session_data::text, '') <> ''
              or session_file_path is not null
            )
          order by created_at desc
          limit 1
          offset ${Math.max(0, Number(process.env.TG_OUTREACH_OFFSET || "0") || 0)}
        `,
      },
    ];

    for (const source of sources) {
      try {
        const rs = await pg.query(source.query);
        const row = rs.rows[0];
        if (!row) continue;
        const apiId = Number(row.api_id || 0);
        const apiHash = String(row.api_hash || "").trim();
        const sessionStr = extractSessionString(row.session_data);
        if (!apiId || !apiHash) continue;
        if (!sessionStr && row.session_file_path) {
          try {
            const localSessionPath = await downloadOutreachSessionFile(String(row.session_file_path));
            return {
              apiId,
              apiHash,
              sessionKind: "sqlite_file",
              sessionValue: localSessionPath,
              source: "db:tg_outreach_accounts:file",
            };
          } catch (err) {
            console.warn(`Outreach session file load failed: ${String(err)}`);
            continue;
          }
        }
        if (!sessionStr) continue;
        return {
          apiId,
          apiHash,
          sessionKind: "string",
          sessionValue: sessionStr,
          source: source.name,
        };
      } catch {
        // Continue fallback search if table is missing or incompatible.
      }
    }

    // Fallback to tg_pool_accounts: api_id/hash from env, session string from pool table.
    const poolApiId = Number(process.env.TG_API_ID || process.env.TELEGRAM_API_ID || "0");
    const poolApiHash = String(process.env.TG_API_HASH || process.env.TELEGRAM_API_HASH || "").trim();
    if (poolApiId && poolApiHash) {
      const poolOffset = Math.max(0, Number(process.env.TG_POOL_OFFSET || "0") || 0);
      try {
        const rs = await pg.query(`
          select session_data::text as session_data
          from tg_pool_accounts
          where status = 'active'
            and coalesce(session_data::text, '') <> ''
          order by created_at desc
          limit 1
          offset ${poolOffset}
        `);
        const row = rs.rows[0];
        if (row) {
          const session = extractPoolSession(row.session_data);
          if (session?.value) {
            return {
              apiId: poolApiId,
              apiHash: poolApiHash,
              sessionKind: session.kind,
              sessionValue: session.value,
              source: "db:tg_pool_accounts",
            };
          }
        }
      } catch {
        // ignore pool fallback query errors
      }
    }

    throw new Error(
      "В БД не найдено активной Telegram-сессии. Добавьте аккаунт в TG Parser/TG Outreach UI или заполните TGPARS_SESSION_STRING в .env."
    );
  } finally {
    await pg.end();
  }
}

async function main() {
  const inputPath = process.argv[2];
  const outputPathArg = process.argv[3];
  if (!inputPath) {
    usage();
    process.exit(1);
  }

  const absoluteInputPath = path.resolve(inputPath);
  const outputPath =
    outputPathArg && outputPathArg.trim()
      ? path.resolve(outputPathArg)
      : path.join(
          path.dirname(absoluteInputPath),
          `${path.basename(absoluteInputPath, path.extname(absoluteInputPath))}_tg_check_result.xlsx`
        );
  const maxContacts = Math.max(1, Number(process.env.TG_MAX_CONTACTS || "200") || 200);

  const creds = await loadTelegramCredentials();
  const apiId = creds.apiId;
  const apiHash = creds.apiHash;

  const workbook = xlsx.readFile(absoluteInputPath, { cellDates: false });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error("В xlsx нет листов");
  const sheet = workbook.Sheets[firstSheetName];
  expandWorksheetRefIfBroken(sheet);
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

  const phoneRecords = collectPhoneRecords(rows);
  if (!phoneRecords.length) {
    throw new Error("Не найдено ни одного телефона в колонках с названиями: телефон/whatsapp/viber/telegram");
  }

  let uniquePhones = [...new Set(phoneRecords.map((r) => r.normalizedPhone))].slice(0, maxContacts);
  const testPhone = String(process.env.TG_TEST_PHONE || "").trim();
  if (testPhone) {
    const normalized = normalizePhone(testPhone);
    if (normalized && !uniquePhones.includes(normalized)) {
      uniquePhones = [normalized, ...uniquePhones].slice(0, maxContacts);
      console.log(`[TEST] Added TG_TEST_PHONE to batch: ${normalized}`);
    }
  }
  const checkedPhones = new Set(uniquePhones);
  console.log(`Rows read: ${rows.length}`);
  console.log(`Phone entries found: ${phoneRecords.length}`);
  console.log(`Unique normalized phones: ${uniquePhones.length}`);
  console.log(`Max contacts requested: ${maxContacts}`);
  console.log(`Telegram creds source: ${creds.source}`);

  /** @type {Map<string, ProbeResult>} */
  const resultsByPhone = new Map();
  uniquePhones.forEach((phone) => {
    resultsByPhone.set(phone, {
      exists: false,
      username: "",
      link: "",
      telegramId: "",
      note: "Аккаунт не найден",
    });
  });

  const session =
    creds.sessionKind === "sqlite_file"
      ? new SQLiteSession(creds.sessionValue)
      : new StringSession(creds.sessionValue);

  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 3,
  });

  await client.connect();
  const authorized = await client.checkAuthorization();
  if (!authorized) {
    throw new Error("Сессия Telegram не авторизована.");
  }

  let globalClientId = BigInt(Date.now()) * 1000n;
  /** @type {Map<string, string>} */
  const clientIdToPhone = new Map();
  /** @type {Map<string, Api.User>} */
  const foundUsersById = new Map();

  const batchSize = Math.max(1, Number(process.env.TG_BATCH_SIZE || "10") || 10);
  let batchIdx = 0;
  for (const phonesBatch of chunk(uniquePhones, batchSize)) {
    batchIdx++;
    const contacts = phonesBatch.map((phone) => {
      globalClientId += 1n;
      const cid = globalClientId;
      clientIdToPhone.set(cid.toString(), phone);
      const phoneForApi = phone.replace(/^\+/, "");
      return new Api.InputPhoneContact({
        clientId: cid,
        phone: phoneForApi,
        firstName: "Lookup",
        lastName: "Run",
      });
    });

    let imported;
    try {
      imported = await client.invoke(new Api.contacts.ImportContacts({ contacts }));
    } catch (err) {
      const errMsg = String(err);
      const floodMatch = errMsg.match(/wait of (\d+) seconds/i);
      if (floodMatch) {
        const waitSec = Number(floodMatch[1]) + 5;
        console.log(`[FLOOD] Batch ${batchIdx}: waiting ${waitSec}s...`);
        await sleep(waitSec * 1000);
        imported = await client.invoke(new Api.contacts.ImportContacts({ contacts }));
      } else {
        throw err;
      }
    }
    const users = imported.users || [];
    if (batchIdx % 10 === 0) {
      console.log(`[PROGRESS] Batch ${batchIdx}/${Math.ceil(uniquePhones.length / batchSize)}`);
    }
    /** @type {Map<string, Api.User>} */
    const usersMap = new Map();
    for (const user of users) {
      if (user && user.className === "User") {
        usersMap.set(String(user.id), user);
      }
    }

    for (const item of imported.imported || []) {
      const phone = clientIdToPhone.get(String(item.clientId));
      const user = usersMap.get(String(item.userId));
      if (!phone || !user) continue;

      const username = user.username ? String(user.username) : "";
      const telegramId = String(user.id);
      const link = username ? `https://t.me/${username}` : "";

      resultsByPhone.set(phone, {
        exists: true,
        username,
        link,
        telegramId,
        note: username ? "Найден публичный username" : "Аккаунт есть, но публичный username отсутствует",
      });
      foundUsersById.set(telegramId, user);
    }

    // Small pause to reduce flood/rate-limit risk.
    await sleep(450);
  }

  const cleanupUsers = [...foundUsersById.values()]
    .filter((u) => u && u.accessHash != null)
    .map((u) => new Api.InputUser({ userId: u.id, accessHash: u.accessHash }));

  for (const usersBatch of chunk(cleanupUsers, 100)) {
    if (!usersBatch.length) continue;
    try {
      await client.invoke(new Api.contacts.DeleteContacts({ id: usersBatch }));
      await sleep(200);
    } catch (err) {
      console.warn(`Cleanup warning: ${String(err)}`);
      break;
    }
  }

  await client.disconnect();

  const outputRows = phoneRecords
    .filter((rec) => checkedPhones.has(rec.normalizedPhone))
    .map((rec) => {
    const probe = resultsByPhone.get(rec.normalizedPhone);
    return {
      "Строка в исходном файле": rec.rowNo,
      "Название компании": rec.company,
      "Колонка источника": rec.sourceColumn,
      "Телефон как в файле": rec.sourceValue,
      "Нормализованный телефон": rec.normalizedPhone,
      "Аккаунт в Telegram": probe?.exists ? "Да" : "Нет",
      "Username": probe?.username ?? "",
      "Ссылка": probe?.link ?? "",
      "Telegram ID": probe?.telegramId ?? "",
      "Комментарий": probe?.note ?? "",
    };
  });

  const outBook = xlsx.utils.book_new();
  const outSheet = xlsx.utils.json_to_sheet(outputRows);
  xlsx.utils.book_append_sheet(outBook, outSheet, "tg_check");
  xlsx.writeFile(outBook, outputPath);

  const existsCount = outputRows.filter((r) => r["Аккаунт в Telegram"] === "Да").length;
  console.log(`Done. Output saved: ${outputPath}`);
  console.log(`Found accounts (rows): ${existsCount}/${outputRows.length}`);
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
