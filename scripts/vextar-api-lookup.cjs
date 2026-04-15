"use strict";

/**
 * Batch INN lookup via Vektor HTTP API (https://infoapi24.store).
 *
 * Reads INNs from .xlsx/.csv, queries the API, writes results to .xlsx + .csv.
 *
 * Usage:
 *   node scripts/vextar-api-lookup.cjs <input.xlsx> [output.xlsx]
 *
 * Environment:
 *   VEKTOR_API_TOKEN  — required, get from @vextarbot: Menu → Мой профиль → API → Создать приложение
 *   VEKTOR_DELAY_MS   — delay between requests (default 1000)
 *   LIMIT             — max INNs to process (0 = all)
 *   INN_COLUMN        — column name override (auto-detect)
 */

const path = require("node:path");
const fs = require("node:fs");

const appNodeModules = path.resolve(__dirname, "..", "app", "node_modules");
const resolveApp = (mod) =>
  require(require.resolve(mod, { paths: [appNodeModules] }));
const xlsx = resolveApp("xlsx");

const API_BASE = "https://infoapi24.store";
const API_TOKEN = (process.env.VEKTOR_API_TOKEN || "").trim();
const DELAY_MS = Math.max(300, Number(process.env.VEKTOR_DELAY_MS || "1000"));
const LIMIT = Number(process.env.LIMIT || "0");
const SKIP = Number(process.env.SKIP || "0");
const SEARCH_MODE = (process.env.SEARCH_MODE || "search").trim(); // "search", "extended_search", or "split"
const SPLIT_AT = Number(process.env.SPLIT_AT || "50"); // for split mode: first N = search, rest = extended

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function usage() {
  console.log(
    "Batch INN lookup via Vektor HTTP API\n\n" +
      "Usage:\n" +
      "  set VEKTOR_API_TOKEN=your_token\n" +
      "  node scripts/vextar-api-lookup.cjs <input.xlsx> [output.xlsx]\n\n" +
      "Get token: @vextarbot → Menu → Мой профиль → API → Создать приложение\n"
  );
}

// ─── Input parsing ─────────────────────────────────────────────────────

const INN_CANDIDATES = ["инн", "inn", "ИНН", "company_inn", "tax_id"];
const COMPANY_CANDIDATES = [
  "название", "наименование", "компания", "company", "name", "Название",
];

function findColumn(headers, candidates, envOverride) {
  if (envOverride) {
    const match = headers.find(
      (h) => h.toLowerCase().trim() === envOverride.toLowerCase().trim()
    );
    if (match) return match;
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
    rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
  } else {
    const wb = xlsx.readFile(filePath, { cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });
  }
  if (!rows.length) throw new Error("Файл пуст");

  const headers = Object.keys(rows[0]);
  const innCol = findColumn(headers, INN_CANDIDATES, process.env.INN_COLUMN);
  if (!innCol)
    throw new Error(
      `Не найдена колонка ИНН. Доступные: ${headers.join(", ")}`
    );

  const companyCol = findColumn(headers, COMPANY_CANDIDATES, process.env.COMPANY_COLUMN);

  const result = [];
  const seen = new Set();
  for (const row of rows) {
    const inn = String(row[innCol] ?? "").trim().replace(/\D/g, "");
    if (!inn || inn.length < 10 || inn.length > 12 || seen.has(inn)) continue;
    seen.add(inn);
    result.push({
      inn,
      company: companyCol ? String(row[companyCol] ?? "").trim() : "",
    });
  }

  console.log(`INN column: "${innCol}", Company column: "${companyCol || "(auto)"}"`);
  console.log(`Rows: ${rows.length}, Unique valid INNs: ${result.length}`);
  return result;
}

// ─── API calls ─────────────────────────────────────────────────────────

async function checkProfile() {
  const res = await fetch(`${API_BASE}/api/${API_TOKEN}/profile`);
  if (!res.ok) throw new Error(`Profile check failed: HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`API error: ${data.error}`);
  return data.profile;
}

async function searchByInn(inn, mode = "search") {
  const endpoint = mode === "extended_search" ? "extended_search" : "search";
  const url = `${API_BASE}/api/${API_TOKEN}/${endpoint}/${inn}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  const data = await res.json();
  if (data.error) return { error: data.error };
  return data;
}

// ─── Result parsing ────────────────────────────────────────────────────

function flattenResults(apiResult) {
  const docs = apiResult.result || {};
  const phones = new Set();
  const emails = new Set();
  const names = new Set();
  const addresses = new Set();
  const birthDates = new Set();
  const passports = new Set();
  const snils = new Set();
  const inns = new Set();
  const databases = [];

  const phoneRe = /^[\d+\s()\-]{7,}$/;
  const emailRe = /^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$/;

  for (const key of Object.keys(docs)) {
    const doc = docs[key];
    if (!doc || typeof doc !== "object") continue;

    for (const [field, value] of Object.entries(doc)) {
      if (!value) continue;
      const v = String(value).trim();
      if (!v) continue;
      const fl = field.toLowerCase();

      if (fl.includes("телефон") || fl.includes("phone") || fl === "тел") {
        v.split(/[,;\n]/).forEach((p) => {
          const cleaned = p.trim();
          if (cleaned.length >= 7) phones.add(cleaned);
        });
      } else if (fl.includes("email") || fl.includes("почта") || fl.includes("e-mail")) {
        v.split(/[,;\n\s]/).forEach((e) => {
          if (emailRe.test(e.trim())) emails.add(e.trim().toLowerCase());
        });
      } else if (fl.includes("фио") || fl.includes("имя") || fl === "name" || fl.includes("фамилия")) {
        if (v.length > 2 && v.length < 100) names.add(v);
      } else if (fl.includes("адрес") || fl.includes("address")) {
        if (v.length > 5) addresses.add(v);
      } else if (fl.includes("дата рождения") || fl.includes("birth")) {
        birthDates.add(v);
      } else if (fl.includes("паспорт") || fl.includes("passport")) {
        passports.add(v);
      } else if (fl.includes("снилс") || fl.includes("snils")) {
        snils.add(v);
      } else if (fl.includes("инн") && !fl.includes("database")) {
        if (/^\d{10,12}$/.test(v)) inns.add(v);
      } else if (fl === "database" || fl.includes("база")) {
        databases.push(v);
      }
    }
  }

  return {
    phones: [...phones],
    emails: [...emails],
    names: [...names],
    addresses: [...addresses],
    birthDates: [...birthDates],
    passports: [...passports],
    snils: [...snils],
    inns: [...inns],
    databases: [...new Set(databases)],
    docCount: Object.keys(docs).length,
  };
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath || !API_TOKEN) {
    usage();
    if (!API_TOKEN) console.error("ERROR: VEKTOR_API_TOKEN not set\n");
    process.exit(1);
  }

  const absoluteInput = path.resolve(inputPath);
  if (!fs.existsSync(absoluteInput)) {
    console.error(`Файл не найден: ${absoluteInput}`);
    process.exit(1);
  }

  const outputBase = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.join(
        path.dirname(absoluteInput),
        `${path.basename(absoluteInput, path.extname(absoluteInput))}_vektor_results`
      );
  const outputXlsx = outputBase.endsWith(".xlsx") ? outputBase : `${outputBase}.xlsx`;
  const outputCsv = outputXlsx.replace(/\.xlsx$/i, ".csv");

  // Check API profile / balance
  console.log("Checking API profile...");
  const profile = await checkProfile();
  console.log(`  App: ${profile.name}, Balance: ${profile.balance}\n`);

  if (profile.balance <= 0) {
    console.error("Баланс 0 — пополни через бота @vextarbot");
    process.exit(1);
  }

  const allRecords = readInput(absoluteInput);
  if (!allRecords.length) {
    console.error("Не найдено ни одного ИНН");
    process.exit(1);
  }

  const afterSkip = SKIP > 0 ? allRecords.slice(SKIP) : allRecords;
  const toProcess = LIMIT > 0 ? afterSkip.slice(0, LIMIT) : afterSkip;

  console.log(`\nSKIP: ${SKIP}, Processing: ${toProcess.length} INNs`);
  console.log(`Mode: ${SEARCH_MODE}${SEARCH_MODE === "split" ? ` (first ${SPLIT_AT} = search, rest = extended_search)` : ""}`);
  console.log(`Delay: ${DELAY_MS}ms`);
  console.log(`Output: ${outputXlsx}\n`);

  function getSearchMode(idx) {
    if (SEARCH_MODE === "split") return idx < SPLIT_AT ? "search" : "extended_search";
    return SEARCH_MODE;
  }

  function saveResults(results) {
    const outputRows = results.map((r) => ({
      ИНН: r.inn,
      Компания: r.company,
      "Тип поиска": r.searchMode === "extended_search" ? "многоуровневый" : "базовый",
      Статус: r.status,
      "Найдено документов": r.parsed.docCount || 0,
      "Телефоны": (r.parsed.phones || []).join("; "),
      "Email": (r.parsed.emails || []).join("; "),
      "ФИО": (r.parsed.names || []).join("; "),
      "Даты рождения": (r.parsed.birthDates || []).join("; "),
      "Адреса": (r.parsed.addresses || []).join("; "),
      "СНИЛС": (r.parsed.snils || []).join("; "),
      "Паспорт": (r.parsed.passports || []).join("; "),
      "Базы данных": (r.parsed.databases || []).join("; "),
      "Ошибка": r.error || "",
      "Raw JSON": r.raw.slice(0, 30000),
    }));
    const ws = xlsx.utils.json_to_sheet(outputRows);
    ws["!cols"] = [
      { wch: 14 }, { wch: 35 }, { wch: 18 }, { wch: 8 }, { wch: 8 },
      { wch: 40 }, { wch: 40 }, { wch: 40 }, { wch: 16 },
      { wch: 50 }, { wch: 18 }, { wch: 18 }, { wch: 50 },
      { wch: 30 }, { wch: 80 },
    ];
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, "Vektor Results");
    xlsx.writeFile(wb, outputXlsx);
    const csvContent = xlsx.utils.sheet_to_csv(ws, { FS: ";", RS: "\n" });
    fs.writeFileSync(outputCsv, "\uFEFF" + csvContent, "utf-8");
  }

  const results = [];
  const total = toProcess.length;

  for (let i = 0; i < total; i++) {
    const { inn, company } = toProcess[i];
    const mode = getSearchMode(i);
    const modeLabel = mode === "extended_search" ? "EXT" : "STD";
    const label = company ? `${company.slice(0, 30)} (${inn})` : inn;
    process.stdout.write(`[${i + 1}/${total}] [${modeLabel}] ${label} ... `);

    try {
      const apiResult = await searchByInn(inn, mode);

      if (apiResult.error) {
        console.log(`✗ ${apiResult.error}`);
        results.push({ inn, company, searchMode: mode, status: "error", error: apiResult.error, parsed: {}, raw: JSON.stringify(apiResult) });
      } else {
        const parsed = flattenResults(apiResult);
        const summary = [];
        if (parsed.docCount) summary.push(`${parsed.docCount} docs`);
        if (parsed.phones.length) summary.push(`${parsed.phones.length} ph`);
        if (parsed.emails.length) summary.push(`${parsed.emails.length} em`);
        if (parsed.names.length) summary.push(`${parsed.names.length} names`);
        console.log(summary.length ? `✓ ${summary.join(", ")}` : "✓ (empty)");
        results.push({ inn, company, searchMode: mode, status: "ok", error: "", parsed, raw: JSON.stringify(apiResult) });
      }
    } catch (err) {
      const msg = err.message || String(err);
      console.log(`✗ ${msg.slice(0, 80)}`);
      results.push({ inn, company, searchMode: mode, status: "error", error: msg, parsed: {}, raw: "" });
    }

    saveResults(results);

    if (i < total - 1) await sleep(DELAY_MS);
  }

  try {
    const after = await checkProfile();
    console.log(`\nBalance after: ${after.balance} (spent: ${(profile.balance - after.balance).toFixed(2)})`);
  } catch { /* ignore */ }

  const okCount = results.filter((r) => r.status === "ok").length;
  const stdResults = results.filter((r) => r.searchMode === "search");
  const extResults = results.filter((r) => r.searchMode === "extended_search");
  const stat = (arr) => ({
    phones: arr.filter((r) => r.parsed.phones?.length).length,
    emails: arr.filter((r) => r.parsed.emails?.length).length,
    names: arr.filter((r) => r.parsed.names?.length).length,
    docs: arr.reduce((s, r) => s + (r.parsed.docCount || 0), 0),
  });
  const errCount = results.filter((r) => r.status === "error").length;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Обработано:     ${total} (ok: ${okCount}, err: ${errCount})`);
  if (stdResults.length) {
    const s = stat(stdResults);
    console.log(`  Базовый (${stdResults.length}): ${s.docs} docs, ${s.phones} с тел, ${s.emails} с email, ${s.names} с ФИО`);
  }
  if (extResults.length) {
    const s = stat(extResults);
    console.log(`  Многоуровневый (${extResults.length}): ${s.docs} docs, ${s.phones} с тел, ${s.emails} с email, ${s.names} с ФИО`);
  }
  console.log(`  XLSX: ${outputXlsx}`);
  console.log(`  CSV:  ${outputCsv}`);
  console.log(`${"═".repeat(60)}`);
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message || err}`);
  process.exit(1);
});
