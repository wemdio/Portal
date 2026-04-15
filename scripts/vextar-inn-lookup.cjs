"use strict";

/**
 * Batch INN lookup via Telegram bot @vextarbot (Вектор).
 *
 * Reads INNs from an .xlsx/.csv file, sends each to the bot,
 * collects responses, and writes results to .xlsx + .csv.
 *
 * Usage:
 *   node --env-file ../app/.env scripts/vextar-inn-lookup.cjs <input.xlsx> [output.xlsx]
 *
 * Environment:
 *   DATABASE_URL                — Postgres connection (for session lookup)
 *   TG_FORCE_OUTREACH_SESSION_PATH — or force a specific session from storage
 *   TG_FORCE_API_ID / TG_FORCE_API_HASH
 *   VEXTAR_DELAY_MS             — delay between requests (default 5000)
 *   VEXTAR_BATCH_PAUSE_MS       — extra pause every N items (default 15000)
 *   VEXTAR_BATCH_PAUSE_EVERY    — pause every N items (default 20)
 *   VEXTAR_MAX_WAIT_MS          — max wait for bot response (default 30000)
 *   INN_COLUMN                  — column name with INN (auto-detect if omitted)
 *   COMPANY_COLUMN              — column name with company name (auto-detect)
 *   LIMIT                       — max number of INNs to process (0 = all)
 */

const path = require("node:path");
const process = require("node:process");
const os = require("node:os");
const fs = require("node:fs");

// Resolve modules from app/node_modules when running from repo root
const appNodeModules = path.resolve(__dirname, "..", "app", "node_modules");
const resolveApp = (mod) => require(require.resolve(mod, { paths: [appNodeModules] }));

const xlsx = resolveApp("xlsx");
let PgClient;
try { PgClient = resolveApp("pg").Client; } catch { PgClient = null; }
let createClient;
try { createClient = resolveApp("@supabase/supabase-js").createClient; } catch { createClient = null; }
const { TelegramClient, Api } = resolveApp("telegram");
const { StringSession } = resolveApp("telegram/sessions");
let SQLiteSession;
try {
  SQLiteSession = resolveApp("gramjs-sqlitesession");
} catch {
  SQLiteSession = null;
}

// ─── Config ────────────────────────────────────────────────────────────
const VEXTAR_BOT_USERNAME = "vextarbot";
const VEXTAR_BOT_ID = 7629240580;

const DELAY_MS = Math.max(2000, Number(process.env.VEXTAR_DELAY_MS || "5000"));
const BATCH_PAUSE_MS = Number(process.env.VEXTAR_BATCH_PAUSE_MS || "15000");
const BATCH_PAUSE_EVERY = Number(process.env.VEXTAR_BATCH_PAUSE_EVERY || "20");
const MAX_WAIT_MS = Number(process.env.VEXTAR_MAX_WAIT_MS || "30000");
const LIMIT = Number(process.env.LIMIT || "0");

// ─── Helpers ───────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function usage() {
  console.log(
    "Batch INN lookup via @vextarbot\n\n" +
      "Usage:\n" +
      '  node --env-file ../app/.env scripts/vextar-inn-lookup.cjs <input.xlsx> [output.xlsx]\n\n' +
      "Env vars:\n" +
      "  VEXTAR_DELAY_MS=5000       delay between INN queries\n" +
      "  LIMIT=10                   max INNs to process (0=all)\n" +
      "  INN_COLUMN=ИНН             column name (auto-detect)\n"
  );
}

// ─── Credential loading (reused from tg-phone-lookup-once.cjs) ─────────

async function downloadOutreachSessionFile(storagePath) {
  const supabaseUrl = String(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ""
  ).trim();
  const supabaseKey = String(
    process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  ).trim();
  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "Не заданы NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY для загрузки .session файла"
    );
  }
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await supabase.storage
    .from("tg-outreach-sessions")
    .download(storagePath);
  if (error || !data) {
    throw new Error(
      `Не удалось скачать .session: ${error?.message || "unknown"}`
    );
  }
  const localPath = path.join(
    os.tmpdir(),
    `tg-vextar-${Date.now()}-${path.basename(storagePath)}`
  );
  fs.writeFileSync(localPath, Buffer.from(await data.arrayBuffer()));
  return localPath;
}

async function loadTelegramCredentials() {
  // Direct session string from env — simplest path, no DB needed
  const directSession = String(process.env.TG_SESSION_STRING || "").trim();
  if (directSession) {
    const apiId = Number(
      process.env.TG_API_ID || process.env.TELEGRAM_API_ID || "0"
    );
    const apiHash = String(
      process.env.TG_API_HASH || process.env.TELEGRAM_API_HASH || ""
    ).trim();
    if (!apiId || !apiHash) {
      throw new Error("TG_SESSION_STRING задан, но нужны TG_API_ID и TG_API_HASH");
    }
    return {
      apiId,
      apiHash,
      sessionKind: "string",
      sessionValue: directSession,
      source: "env:TG_SESSION_STRING",
    };
  }

  const forcedPath = String(
    process.env.TG_FORCE_OUTREACH_SESSION_PATH || ""
  ).trim();
  if (forcedPath) {
    const apiId = Number(
      process.env.TG_FORCE_API_ID ||
        process.env.TG_API_ID ||
        process.env.TELEGRAM_API_ID ||
        "0"
    );
    const apiHash = String(
      process.env.TG_FORCE_API_HASH ||
        process.env.TG_API_HASH ||
        process.env.TELEGRAM_API_HASH ||
        ""
    ).trim();
    if (!apiId || !apiHash) {
      throw new Error(
        "Для TG_FORCE_OUTREACH_SESSION_PATH нужны TG_FORCE_API_ID и TG_FORCE_API_HASH"
      );
    }
    const localSessionPath = await downloadOutreachSessionFile(forcedPath);
    return {
      apiId,
      apiHash,
      sessionKind: "sqlite_file",
      sessionValue: localSessionPath,
      source: "env:TG_FORCE_OUTREACH_SESSION_PATH",
    };
  }

  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) {
    throw new Error("Отсутствует DATABASE_URL. Нужна запись в tg_parser_accounts или tg_outreach_accounts.");
  }

  const pg = new PgClient({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });
  await pg.connect();
  try {
    const extractSessionString = (raw) => {
      const text = String(raw ?? "").trim();
      if (!text) return "";
      if (text.startsWith("{") || text.startsWith('"')) {
        try {
          const parsed = JSON.parse(text);
          if (typeof parsed === "string") return parsed.trim();
          if (parsed && typeof parsed === "object" && typeof parsed.session_string === "string") {
            return parsed.session_string.trim();
          }
        } catch { /* not JSON */ }
      }
      return text;
    };

    const sources = [
      {
        name: "db:tg_parser_accounts",
        query: `SELECT api_id, api_hash, session_data::text as session_data
                FROM tg_parser_accounts
                WHERE is_active = true AND coalesce(session_data::text, '') <> ''
                ORDER BY created_at DESC LIMIT 1`,
      },
      {
        name: "db:tg_outreach_accounts",
        query: `SELECT api_id, api_hash, session_data::text as session_data, session_file_path
                FROM tg_outreach_accounts
                WHERE is_active = true
                  AND (coalesce(session_data::text, '') <> '' OR session_file_path IS NOT NULL)
                ORDER BY created_at DESC LIMIT 1`,
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
            const local = await downloadOutreachSessionFile(
              String(row.session_file_path)
            );
            return {
              apiId,
              apiHash,
              sessionKind: "sqlite_file",
              sessionValue: local,
              source: `${source.name}:file`,
            };
          } catch {
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
      } catch { /* table might not exist */ }
    }

    const poolApiId = Number(
      process.env.TG_API_ID || process.env.TELEGRAM_API_ID || "0"
    );
    const poolApiHash = String(
      process.env.TG_API_HASH || process.env.TELEGRAM_API_HASH || ""
    ).trim();
    if (poolApiId && poolApiHash) {
      try {
        const rs = await pg.query(`
          SELECT session_data::text as session_data
          FROM tg_pool_accounts
          WHERE status = 'active' AND coalesce(session_data::text, '') <> ''
          ORDER BY created_at DESC LIMIT 1
        `);
        const row = rs.rows[0];
        if (row) {
          const text = extractSessionString(row.session_data);
          if (text) {
            return {
              apiId: poolApiId,
              apiHash: poolApiHash,
              sessionKind: "string",
              sessionValue: text,
              source: "db:tg_pool_accounts",
            };
          }
        }
      } catch { /* ignore */ }
    }

    throw new Error(
      "Не найдено активной Telegram-сессии в БД."
    );
  } finally {
    await pg.end();
  }
}

// ─── XLSX / CSV input parsing ──────────────────────────────────────────

function expandWorksheetRefIfBroken(sheet) {
  const cellKeys = Object.keys(sheet).filter((k) => /^[A-Z]+\d+$/.test(k));
  if (!cellKeys.length) return;
  let maxRow = 0;
  for (const key of cellKeys) {
    const row = Number(key.match(/\d+$/)[0]);
    if (row > maxRow) maxRow = row;
  }
  if (!maxRow) return;
  const currentRef = String(sheet["!ref"] || "").trim();
  const declaredEndRow = currentRef.includes(":")
    ? Number(currentRef.split(":")[1].match(/\d+$/)?.[0] || 0)
    : 0;
  if (declaredEndRow >= maxRow) return;
  const maxCellRef = cellKeys.reduce((best, cell) => {
    const c = xlsx.utils.decode_cell(cell);
    const b = xlsx.utils.decode_cell(best);
    return c.r > b.r || (c.r === b.r && c.c > b.c) ? cell : best;
  }, "A1");
  sheet["!ref"] = `A1:${maxCellRef}`;
}

const INN_COLUMN_CANDIDATES = ["инн", "inn", "ИНН", "company_inn", "tax_id"];
const COMPANY_COLUMN_CANDIDATES = [
  "название",
  "наименование",
  "компания",
  "company",
  "name",
  "company_name",
  "Название",
];

function findColumn(headers, candidates, envOverride) {
  if (envOverride) {
    const exact = headers.find((h) => h === envOverride);
    if (exact) return exact;
    const lower = headers.find(
      (h) => h.toLowerCase().trim() === envOverride.toLowerCase().trim()
    );
    if (lower) return lower;
  }
  for (const c of candidates) {
    const match = headers.find(
      (h) => h.toLowerCase().trim() === c.toLowerCase()
    );
    if (match) return match;
  }
  return null;
}

function readInput(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let rows;

  if (ext === ".csv") {
    const raw = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
    const wb = xlsx.read(raw, { type: "string" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });
  } else {
    const wb = xlsx.readFile(filePath, { cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    expandWorksheetRefIfBroken(sheet);
    rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });
  }

  if (!rows.length) throw new Error("Файл пуст");

  const headers = Object.keys(rows[0]);
  const innCol = findColumn(
    headers,
    INN_COLUMN_CANDIDATES,
    process.env.INN_COLUMN
  );
  if (!innCol) {
    throw new Error(
      `Не найдена колонка с ИНН. Доступные: ${headers.join(", ")}.\nУкажите INN_COLUMN=имя_колонки`
    );
  }

  const companyCol = findColumn(
    headers,
    COMPANY_COLUMN_CANDIDATES,
    process.env.COMPANY_COLUMN
  );

  const result = [];
  const seen = new Set();
  for (const row of rows) {
    const rawInn = String(row[innCol] ?? "").trim();
    const inn = rawInn.replace(/\D/g, "");
    if (!inn || inn.length < 10 || inn.length > 12) continue;
    if (seen.has(inn)) continue;
    seen.add(inn);
    result.push({
      inn,
      company: companyCol ? String(row[companyCol] ?? "").trim() : "",
      originalRow: row,
    });
  }

  console.log(`INN column: "${innCol}", Company column: "${companyCol || "(not found)"}"`);
  console.log(`Rows read: ${rows.length}, Unique valid INNs: ${result.length}`);
  return result;
}

// ─── Bot interaction ───────────────────────────────────────────────────

async function waitForBotMessages(client, botPeer, afterDate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const collected = [];
  let lastCheck = afterDate;

  while (Date.now() < deadline) {
    await sleep(2000);

    try {
      const history = await client.invoke(
        new Api.messages.GetHistory({
          peer: botPeer,
          limit: 10,
          offsetDate: 0,
          offsetId: 0,
          addOffset: 0,
          maxId: 0,
          minId: 0,
          hash: BigInt(0),
        })
      );

      const messages = (history.messages || [])
        .filter((m) => m.className === "Message")
        .filter((m) => {
          const fromId = m.fromId;
          if (!fromId) return m.peerId?.className === "PeerUser";
          if (fromId.className === "PeerUser") {
            return Number(fromId.userId) === VEXTAR_BOT_ID;
          }
          return false;
        })
        .filter((m) => m.date > lastCheck);

      if (messages.length > 0) {
        for (const msg of messages) {
          collected.push(msg);
          if (msg.date > lastCheck) lastCheck = msg.date;
        }
        // Wait a bit more in case multiple messages come in sequence
        await sleep(1500);

        const more = await client.invoke(
          new Api.messages.GetHistory({
            peer: botPeer,
            limit: 5,
            offsetDate: 0,
            offsetId: 0,
            addOffset: 0,
            maxId: 0,
            minId: 0,
            hash: BigInt(0),
          })
        );
        const extra = (more.messages || [])
          .filter((m) => m.className === "Message")
          .filter((m) => {
            const fromId = m.fromId;
            if (!fromId) return true;
            return (
              fromId.className === "PeerUser" &&
              Number(fromId.userId) === VEXTAR_BOT_ID
            );
          })
          .filter((m) => m.date > lastCheck);

        for (const msg of extra) {
          collected.push(msg);
          if (msg.date > lastCheck) lastCheck = msg.date;
        }
        break;
      }
    } catch (err) {
      console.warn(`  [warn] GetHistory error: ${err.message}`);
    }
  }

  return collected;
}

async function clickInlineButton(client, botPeer, msg, buttonText) {
  const rows = msg.replyMarkup?.rows || [];
  for (const row of rows) {
    for (const btn of row.buttons || []) {
      const text = String(btn.text || "").trim();
      if (text.includes(buttonText)) {
        if (btn.className === "KeyboardButtonCallback" || btn.data) {
          return client.invoke(
            new Api.messages.GetBotCallbackAnswer({
              peer: botPeer,
              msgId: msg.id,
              data: btn.data,
            })
          );
        }
        if (btn.className === "KeyboardButtonUrl" && btn.url) {
          return { url: btn.url };
        }
      }
    }
  }
  return null;
}

function listButtons(msg) {
  const result = [];
  const rows = msg.replyMarkup?.rows || [];
  for (const row of rows) {
    for (const btn of row.buttons || []) {
      result.push(String(btn.text || "").trim());
    }
  }
  return result;
}

async function clickFirstMatchingButton(client, botPeer, msg, keywords) {
  const rows = msg.replyMarkup?.rows || [];
  for (const kw of keywords) {
    for (const row of rows) {
      for (const btn of row.buttons || []) {
        const text = String(btn.text || "").trim().toLowerCase();
        if (text.includes(kw.toLowerCase())) {
          if (btn.data) {
            try {
              return await client.invoke(
                new Api.messages.GetBotCallbackAnswer({
                  peer: botPeer,
                  msgId: msg.id,
                  data: btn.data,
                })
              );
            } catch (e) {
              console.warn(`  [warn] clickButton "${btn.text}": ${e.message}`);
            }
          }
        }
      }
    }
  }
  return null;
}

function parseVextarResponse(messages) {
  const allText = messages
    .map((m) => String(m.message || ""))
    .filter(Boolean)
    .join("\n\n---\n\n");

  if (!allText.trim()) return { raw: "", parsed: {} };

  const parsed = {};

  const phoneRe = /(?:телефон|phone|тел)[:\s]*([+\d()\-\s]{7,})/gi;
  const phones = [];
  let pm;
  while ((pm = phoneRe.exec(allText)) !== null) {
    phones.push(pm[1].trim());
  }
  // Also find standalone phone patterns
  const standalonePhoneRe = /(?<!\d)(\+?[78][\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2})(?!\d)/g;
  while ((pm = standalonePhoneRe.exec(allText)) !== null) {
    if (!phones.includes(pm[1].trim())) phones.push(pm[1].trim());
  }
  if (phones.length) parsed.phones = [...new Set(phones)];

  const emailRe = /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g;
  const emails = [];
  let em;
  while ((em = emailRe.exec(allText)) !== null) {
    emails.push(em[0].toLowerCase());
  }
  if (emails.length) parsed.emails = [...new Set(emails)];

  const namePatterns = [
    /(?:ФИО|Имя|Name|ФИ)[:\s]*(.+)/i,
    /(?:Руководитель|Директор|Director|CEO)[:\s]*(.+)/i,
  ];
  for (const re of namePatterns) {
    const m = allText.match(re);
    if (m) {
      parsed.name = m[1].trim().split("\n")[0].trim();
      break;
    }
  }

  const addressPatterns = [
    /(?:Адрес|Address|Юр\.?\s*адрес)[:\s]*(.+)/i,
  ];
  for (const re of addressPatterns) {
    const m = allText.match(re);
    if (m) {
      parsed.address = m[1].trim().split("\n")[0].trim();
      break;
    }
  }

  const tgPatterns = [
    /(?:telegram|тг|tg)[:\s]*@?([a-zA-Z0-9_]{3,})/i,
    /@([a-zA-Z0-9_]{3,})/g,
  ];
  const tgUsernames = [];
  for (const re of tgPatterns) {
    if (re.global) {
      let tm;
      while ((tm = re.exec(allText)) !== null) {
        const u = tm[1].toLowerCase();
        if (u !== "vextarbot" && !tgUsernames.includes(u)) tgUsernames.push(u);
      }
    } else {
      const m = allText.match(re);
      if (m) {
        const u = m[1].toLowerCase();
        if (u !== "vextarbot" && !tgUsernames.includes(u)) tgUsernames.push(u);
      }
    }
  }
  if (tgUsernames.length) parsed.telegram = tgUsernames;

  const snsPatterns = [
    /(?:СНИЛС|SNILS)[:\s]*(\d[\d\s\-]{9,})/i,
  ];
  for (const re of snsPatterns) {
    const m = allText.match(re);
    if (m) {
      parsed.snils = m[1].trim();
      break;
    }
  }

  const passportPatterns = [
    /(?:Паспорт|Passport)[:\s]*(\d[\d\s]{6,})/i,
  ];
  for (const re of passportPatterns) {
    const m = allText.match(re);
    if (m) {
      parsed.passport = m[1].trim();
      break;
    }
  }

  return { raw: allText, parsed };
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    usage();
    process.exit(1);
  }

  const absoluteInput = path.resolve(inputPath);
  if (!fs.existsSync(absoluteInput)) {
    console.error(`Файл не найден: ${absoluteInput}`);
    process.exit(1);
  }

  const outputBase =
    process.argv[3] && process.argv[3].trim()
      ? path.resolve(process.argv[3])
      : path.join(
          path.dirname(absoluteInput),
          `${path.basename(absoluteInput, path.extname(absoluteInput))}_vextar_results`
        );

  const outputXlsx = outputBase.endsWith(".xlsx")
    ? outputBase
    : `${outputBase}.xlsx`;
  const outputCsv = outputXlsx.replace(/\.xlsx$/i, ".csv");

  const records = readInput(absoluteInput);
  if (!records.length) {
    console.error("Не найдено ни одного ИНН");
    process.exit(1);
  }

  let toProcess = records;
  if (LIMIT > 0) toProcess = records.slice(0, LIMIT);

  console.log(`\nWill process: ${toProcess.length} INNs`);
  console.log(`Delay between requests: ${DELAY_MS}ms`);
  console.log(`Output XLSX: ${outputXlsx}`);
  console.log(`Output CSV:  ${outputCsv}\n`);

  // Load Telegram session
  const creds = await loadTelegramCredentials();
  console.log(`Telegram session source: ${creds.source}`);

  const session =
    creds.sessionKind === "sqlite_file" && SQLiteSession
      ? new SQLiteSession(creds.sessionValue)
      : new StringSession(creds.sessionValue);

  const client = new TelegramClient(session, creds.apiId, creds.apiHash, {
    connectionRetries: 5,
  });

  await client.connect();
  const authorized = await client.checkAuthorization();
  if (!authorized) {
    throw new Error("Сессия Telegram не авторизована.");
  }
  console.log("Telegram: connected and authorized\n");

  // Resolve the bot entity
  let botEntity;
  try {
    botEntity = await client.getEntity(VEXTAR_BOT_USERNAME);
  } catch {
    botEntity = await client.getEntity(BigInt(VEXTAR_BOT_ID));
  }
  const botPeer = new Api.InputPeerUser({
    userId: botEntity.id,
    accessHash: botEntity.accessHash || BigInt(0),
  });

  // Initialize: send /start to the bot
  console.log("Sending /start to @vextarbot...");
  await client.sendMessage(botPeer, { message: "/start" });
  await sleep(3000);

  // Get the menu message and click "Поиск"
  const initHistory = await client.invoke(
    new Api.messages.GetHistory({
      peer: botPeer,
      limit: 5,
      offsetDate: 0,
      offsetId: 0,
      addOffset: 0,
      maxId: 0,
      minId: 0,
      hash: BigInt(0),
    })
  );

  const menuMsg = (initHistory.messages || []).find(
    (m) => m.replyMarkup && String(m.message || "").includes("Вектор")
  );

  if (menuMsg) {
    console.log('Found menu, clicking "Поиск"...');
    try {
      await clickFirstMatchingButton(client, botPeer, menuMsg, ["Поиск"]);
      await sleep(2000);
    } catch (err) {
      console.warn(`Could not click Поиск button: ${err.message}`);
      await client.sendMessage(botPeer, { message: "🔍 Поиск" });
      await sleep(2000);
    }
  } else {
    console.log("No menu found, sending search command directly...");
    await client.sendMessage(botPeer, { message: "🔍 Поиск" });
    await sleep(2000);
  }

  // Process each INN
  const results = [];
  const total = toProcess.length;

  for (let i = 0; i < total; i++) {
    const { inn, company } = toProcess[i];
    const label = company ? `${company.slice(0, 30)} (${inn})` : inn;
    process.stdout.write(`[${i + 1}/${total}] ${label} ... `);

    const beforeSend = Math.floor(Date.now() / 1000) - 1;

    try {
      // Helper: fetch last N messages from the bot chat
      async function getRecentBotMessages(limit = 15) {
        const history = await client.invoke(
          new Api.messages.GetHistory({
            peer: botPeer,
            limit,
            offsetDate: 0,
            offsetId: 0,
            addOffset: 0,
            maxId: 0,
            minId: 0,
            hash: BigInt(0),
          })
        );
        return (history.messages || []).filter(
          (m) => m.className === "Message"
        );
      }

      // Helper: get the latest message from the bot (not from us)
      function latestBotMsg(msgs) {
        return msgs.find((m) => {
          const fromId = m.fromId;
          if (!fromId) return true;
          return (
            fromId.className === "PeerUser" &&
            Number(fromId.userId) === VEXTAR_BOT_ID
          );
        });
      }

      // Step 1: send the INN
      await client.sendMessage(botPeer, { message: inn });
      await sleep(3000);

      // Step 2: get bot response — should be "Выберите направление" with buttons
      let msgs = await getRecentBotMessages();
      let botMsg = latestBotMsg(msgs);
      const botMsgText = String(botMsg?.message || "");

      if (i < 5) {
        const btns = botMsg ? listButtons(botMsg) : [];
        console.log(`\n  [debug] Bot: "${botMsgText.slice(0, 80)}" buttons=[${btns.join("|")}]`);
      }

      // Step 3: if bot asks to choose direction, click "Базовый поиск"
      let resultText = botMsgText;
      if (botMsg?.replyMarkup && botMsgText.includes("направление")) {
        await clickFirstMatchingButton(client, botPeer, botMsg, [
          "базовый поиск",
          "базовый",
          "поиск",
        ]);
        await sleep(4000);

        // Re-fetch messages — bot may have sent new message or edited
        msgs = await getRecentBotMessages();
        const newBotMsg = latestBotMsg(msgs);
        const newText = String(newBotMsg?.message || "");

        if (i < 5) {
          const btns2 = newBotMsg ? listButtons(newBotMsg) : [];
          console.log(`  [debug] After click: "${newText.slice(0, 120)}" buttons=[${btns2.join("|")}]`);
        }

        // If the message changed, use new text
        if (newText && newText !== botMsgText) {
          resultText = newText;
          botMsg = newBotMsg;
        } else {
          // Bot might have edited the same message — check if the direction msg text changed
          const refreshedDirMsg = msgs.find(
            (m) =>
              m.className === "Message" &&
              m.id === botMsg.id
          );
          if (refreshedDirMsg) {
            const refreshedText = String(refreshedDirMsg.message || "");
            if (refreshedText !== botMsgText) {
              resultText = refreshedText;
            }
          }
        }

        // Step 4: if still just "направление", wait more and retry
        if (resultText.includes("направление") || resultText === botMsgText) {
          await sleep(5000);
          msgs = await getRecentBotMessages(20);
          // Find ALL messages from bot after our INN message, sorted by date desc
          const allBotMsgs = msgs
            .filter((m) => {
              const fromId = m.fromId;
              if (!fromId) return true;
              return (
                fromId.className === "PeerUser" &&
                Number(fromId.userId) === VEXTAR_BOT_ID
              );
            })
            .filter((m) => m.date >= beforeSend);

          if (i < 5) {
            console.log(`  [debug] Extended wait: ${allBotMsgs.length} bot msgs since send`);
            allBotMsgs.slice(0, 5).forEach((m, idx) => {
              console.log(`    [${idx}] date=${m.date} "${String(m.message || "").slice(0, 100)}" btns=${listButtons(m).join("|")}`);
            });
          }

          // Collect all non-direction texts
          const resultTexts = allBotMsgs
            .map((m) => String(m.message || ""))
            .filter((t) => t.trim() && !t.includes("Выберите направление"));

          if (resultTexts.length) {
            resultText = resultTexts.join("\n\n---\n\n");
          }
        }
      }

      const { raw, parsed } = parseVextarResponse([
        { message: resultText },
      ]);
      const summary = [];
      if (parsed.phones?.length)
        summary.push(`${parsed.phones.length} phones`);
      if (parsed.emails?.length)
        summary.push(`${parsed.emails.length} emails`);
      if (parsed.name) summary.push(`name: ${parsed.name.slice(0, 25)}`);
      if (parsed.telegram?.length)
        summary.push(`tg: @${parsed.telegram[0]}`);

      const preview = resultText.replace(/\n/g, " ").slice(0, 60);
      console.log(
        summary.length
          ? `✓ ${summary.join(", ")}`
          : `✓ "${preview}..."`
      );

      results.push({ inn, company, status: "ok", raw: resultText, parsed });
    } catch (err) {
      const errMsg = err.message || String(err);
      console.log(`✗ ${errMsg.slice(0, 60)}`);

      // Handle flood wait
      const floodMatch = errMsg.match(/wait of (\d+) seconds/i);
      if (floodMatch) {
        const waitSec = Number(floodMatch[1]) + 10;
        console.log(`  [FLOOD] Waiting ${waitSec}s...`);
        await sleep(waitSec * 1000);
      }

      results.push({
        inn,
        company,
        status: "error",
        raw: errMsg,
        parsed: {},
      });
    }

    // Delay between requests
    if (i < total - 1) {
      if ((i + 1) % BATCH_PAUSE_EVERY === 0) {
        console.log(
          `  [pause] Batch pause ${BATCH_PAUSE_MS / 1000}s after ${i + 1} items...`
        );
        await sleep(BATCH_PAUSE_MS);
      } else {
        await sleep(DELAY_MS);
      }
    }
  }

  await client.disconnect();

  // ─── Build output ──────────────────────────────────────────────────
  const outputRows = results.map((r) => ({
    ИНН: r.inn,
    Компания: r.company,
    Статус: r.status,
    "Телефоны": (r.parsed.phones || []).join("; "),
    "Email": (r.parsed.emails || []).join("; "),
    "ФИО / Имя": r.parsed.name || "",
    "Адрес": r.parsed.address || "",
    "Telegram": (r.parsed.telegram || []).map((u) => `@${u}`).join("; "),
    "СНИЛС": r.parsed.snils || "",
    "Паспорт": r.parsed.passport || "",
    "Полный ответ бота": r.raw.slice(0, 30000),
  }));

  // Write XLSX
  const ws = xlsx.utils.json_to_sheet(outputRows);
  ws["!cols"] = [
    { wch: 14 },  // ИНН
    { wch: 35 },  // Компания
    { wch: 10 },  // Статус
    { wch: 40 },  // Телефоны
    { wch: 40 },  // Email
    { wch: 35 },  // ФИО
    { wch: 50 },  // Адрес
    { wch: 25 },  // Telegram
    { wch: 18 },  // СНИЛС
    { wch: 18 },  // Паспорт
    { wch: 80 },  // Полный ответ
  ];
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, "Vextar Results");
  xlsx.writeFile(wb, outputXlsx);

  // Write CSV
  const csvContent = xlsx.utils.sheet_to_csv(ws, { FS: ";", RS: "\n" });
  fs.writeFileSync(outputCsv, "\uFEFF" + csvContent, "utf-8");

  // Summary
  const okCount = results.filter((r) => r.status === "ok").length;
  const withPhones = results.filter((r) => r.parsed.phones?.length).length;
  const withEmails = results.filter((r) => r.parsed.emails?.length).length;
  const withNames = results.filter((r) => r.parsed.name).length;
  const withTg = results.filter((r) => r.parsed.telegram?.length).length;
  const errCount = results.filter((r) => r.status === "error").length;
  const timeoutCount = results.filter((r) => r.status === "timeout").length;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Обработано:     ${total}`);
  console.log(`  Ответ получен:  ${okCount}`);
  console.log(`  С телефонами:   ${withPhones}`);
  console.log(`  С email:        ${withEmails}`);
  console.log(`  С ФИО:          ${withNames}`);
  console.log(`  С Telegram:     ${withTg}`);
  console.log(`  Ошибки:         ${errCount}`);
  console.log(`  Timeout:        ${timeoutCount}`);
  console.log(`  XLSX: ${outputXlsx}`);
  console.log(`  CSV:  ${outputCsv}`);
  console.log(`${"═".repeat(60)}`);
}

main().catch((err) => {
  console.error(`\nFATAL: ${err instanceof Error ? err.message : String(err)}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
