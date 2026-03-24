#!/usr/bin/env node
/* eslint-disable no-console */
const path = require("path");
const ExcelJS = require("exceljs");
const { load } = require("cheerio");

const DEFAULT_MAX_ROWS = 0;
const DEFAULT_MAX_PAGES_PER_SITE = 4;
const DEFAULT_TIMEOUT_MS = 12000;

const WEBSITE_HEADER_HINTS = [
  "website",
  "web site",
  "site",
  "url",
  "domain",
  "web",
  "company website",
  "company url",
  "сайт",
  "вебсайт",
  "домен",
  "ссылка",
];

const COMPANY_HEADER_HINTS = [
  "company",
  "company name",
  "organization",
  "org",
  "name",
  "merchant",
  "vendor",
  "компания",
  "название компании",
  "название",
  "организация",
];

const CRYPTO_KEYWORDS = [
  "crypto payment",
  "cryptocurrency payment",
  "pay with crypto",
  "bitcoin accepted",
  "bitcoin payment",
  "ethereum payment",
  "usdt payment",
  "usdc payment",
  "оплата криптовалютой",
  "оплата в криптовалюте",
  "оплата криптой",
  "оплата в крипте",
  "bitcoin",
  "btc",
  "ethereum",
  "eth",
  "usdt",
  "usdc",
  "ton",
  "solana",
  "tron",
  "walletconnect",
  "metamask",
  "coinbase commerce",
  "bitpay",
  "coingate",
  "coinpayments",
  "nowpayments",
  "cryptomus",
  "binance pay",
  "bybit pay",
];

const CRYPTO_PROVIDER_HOST_HINTS = [
  "commerce.coinbase.com",
  "bitpay.com",
  "coingate.com",
  "coinpayments.net",
  "nowpayments.io",
  "cryptomus.com",
  "binance.com",
  "walletconnect",
  "metamask",
];

function parseArgs(argv) {
  const args = {
    input: "",
    output: "",
    sheet: "",
    maxRows: DEFAULT_MAX_ROWS,
    maxPagesPerSite: DEFAULT_MAX_PAGES_PER_SITE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--input" && next) {
      args.input = next;
      i += 1;
    } else if (token === "--output" && next) {
      args.output = next;
      i += 1;
    } else if (token === "--sheet" && next) {
      args.sheet = next;
      i += 1;
    } else if (token === "--max-rows" && next) {
      args.maxRows = Number(next) || DEFAULT_MAX_ROWS;
      i += 1;
    } else if (token === "--max-pages" && next) {
      args.maxPagesPerSite = Math.max(1, Number(next) || DEFAULT_MAX_PAGES_PER_SITE);
      i += 1;
    } else if (token === "--timeout-ms" && next) {
      args.timeoutMs = Math.max(1000, Number(next) || DEFAULT_TIMEOUT_MS);
      i += 1;
    }
  }

  if (!args.input) {
    throw new Error("Укажите путь к файлу: --input \"G:\\...\\file.xlsx\"");
  }
  if (!args.output) {
    const parsed = path.parse(args.input);
    args.output = path.join(parsed.dir, `${parsed.name}.crypto-payments.xlsx`);
  }

  return args;
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function getCellString(row, columnIndex) {
  const value = row.getCell(columnIndex).value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && value.hyperlink) return String(value.hyperlink);
  if (typeof value === "object" && value.text) return String(value.text);
  return String(value).trim();
}

function normalizeUrl(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;
  if (/\s/.test(value)) return null;

  let candidate = value;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  try {
    const url = new URL(candidate);
    if (!url.hostname || !url.hostname.includes(".")) return null;
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function scoreHeader(header, hints) {
  if (!header) return 0;
  if (hints.some((hint) => header === hint)) return 4;
  if (hints.some((hint) => header.includes(hint))) return 2;
  return 0;
}

function detectBestColumn(worksheet, hints, sampleRowsCount = 120) {
  const maxColumn = worksheet.columnCount;
  let best = { index: 0, score: -1 };

  for (let col = 1; col <= maxColumn; col += 1) {
    const header = normalizeText(getCellString(worksheet.getRow(1), col));
    const headerScore = scoreHeader(header, hints);

    let nonEmpty = 0;
    let urlLike = 0;
    const maxRow = Math.min(worksheet.rowCount, 1 + sampleRowsCount);
    for (let rowNumber = 2; rowNumber <= maxRow; rowNumber += 1) {
      const raw = getCellString(worksheet.getRow(rowNumber), col);
      if (!raw) continue;
      nonEmpty += 1;
      if (normalizeUrl(raw)) urlLike += 1;
    }
    const ratio = nonEmpty > 0 ? urlLike / nonEmpty : 0;
    const totalScore = headerScore + ratio * 2;

    if (totalScore > best.score) {
      best = { index: col, score: totalScore };
    }
  }

  return best.index;
}

async function fetchHtml(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CryptoPaymentProbe/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) {
      return { ok: false, status: res.status, url };
    }
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      return { ok: false, status: res.status, url };
    }
    const html = await res.text();
    return { ok: true, html, finalUrl: res.url || url };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), url };
  } finally {
    clearTimeout(timer);
  }
}

function extractEvidence(html) {
  const $ = load(html);
  const text = $("body").text().toLowerCase().replace(/\s+/g, " ");
  const snippets = [];

  for (const keyword of CRYPTO_KEYWORDS) {
    const idx = text.indexOf(keyword);
    if (idx >= 0) {
      const start = Math.max(0, idx - 45);
      const end = Math.min(text.length, idx + keyword.length + 45);
      snippets.push(`...${text.slice(start, end).trim()}...`);
      if (snippets.length >= 3) break;
    }
  }

  const linkedHosts = [];
  $("script[src], link[href], a[href], iframe[src]").each((_, el) => {
    const attr = $(el).attr("src") || $(el).attr("href");
    if (!attr) return;
    const lower = attr.toLowerCase();
    for (const hostHint of CRYPTO_PROVIDER_HOST_HINTS) {
      if (lower.includes(hostHint)) linkedHosts.push(hostHint);
    }
  });

  return {
    hasKeyword: snippets.length > 0,
    snippets,
    providerHints: [...new Set(linkedHosts)],
  };
}

function buildPagesToCheck(homeUrl, maxPagesPerSite) {
  const base = new URL(homeUrl);
  const paths = [
    "/",
    "/checkout",
    "/payment",
    "/payments",
    "/pay",
    "/cart",
    "/billing",
    "/pricing",
    "/faq",
    "/help",
  ];

  return paths.slice(0, maxPagesPerSite).map((pathname) => {
    const url = new URL(base.toString());
    url.pathname = pathname;
    url.search = "";
    url.hash = "";
    return url.toString();
  });
}

async function detectCryptoOnSite(website, maxPagesPerSite, timeoutMs) {
  const homeUrl = normalizeUrl(website);
  if (!homeUrl) {
    return { hasCryptoPayment: false, reason: "invalid_url" };
  }

  const pages = buildPagesToCheck(homeUrl, maxPagesPerSite);
  const pageFindings = [];

  for (const pageUrl of pages) {
    const res = await fetchHtml(pageUrl, timeoutMs);
    if (!res.ok || !res.html) continue;

    const evidence = extractEvidence(res.html);
    const hasCryptoPayment = evidence.hasKeyword || evidence.providerHints.length > 0;
    pageFindings.push({
      pageUrl: res.finalUrl || pageUrl,
      snippets: evidence.snippets,
      providerHints: evidence.providerHints,
      hasCryptoPayment,
    });

    if (hasCryptoPayment) {
      return {
        hasCryptoPayment: true,
        matchedUrl: res.finalUrl || pageUrl,
        evidence: evidence.snippets.join(" | "),
        providerHints: evidence.providerHints.join(", "),
      };
    }
  }

  return {
    hasCryptoPayment: false,
    reason: pageFindings.length === 0 ? "unreachable_or_no_html" : "no_crypto_markers",
  };
}

async function writeResultWorkbook(outputPath, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("crypto_payments");

  ws.columns = [
    { header: "company_name", key: "companyName", width: 40 },
    { header: "website", key: "website", width: 45 },
    { header: "has_crypto_payment", key: "hasCryptoPayment", width: 20 },
    { header: "matched_url", key: "matchedUrl", width: 55 },
    { header: "evidence", key: "evidence", width: 80 },
    { header: "provider_hints", key: "providerHints", width: 40 },
    { header: "reason", key: "reason", width: 30 },
  ];

  for (const row of rows) {
    ws.addRow(row);
  }

  await wb.xlsx.writeFile(outputPath);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(args.input);

  const worksheet = args.sheet
    ? workbook.getWorksheet(args.sheet)
    : workbook.worksheets[0];

  if (!worksheet) {
    throw new Error(`Лист "${args.sheet}" не найден`);
  }

  const websiteCol = detectBestColumn(worksheet, WEBSITE_HEADER_HINTS);
  if (!websiteCol) {
    throw new Error("Не удалось определить колонку с сайтом");
  }

  const companyCol = detectBestColumn(worksheet, COMPANY_HEADER_HINTS);
  const results = [];
  const matched = [];
  const lastRow = args.maxRows > 0 ? Math.min(worksheet.rowCount, args.maxRows + 1) : worksheet.rowCount;

  console.log(`Файл: ${args.input}`);
  console.log(`Лист: ${worksheet.name}`);
  console.log(`Колонка сайта: #${websiteCol}`);
  console.log(`Колонка компании: #${companyCol || 1}`);
  console.log(`Проверяем строк: ${Math.max(0, lastRow - 1)}\n`);

  for (let rowNumber = 2; rowNumber <= lastRow; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const websiteRaw = getCellString(row, websiteCol);
    const companyName = getCellString(row, companyCol || 1) || `row_${rowNumber}`;
    const website = normalizeUrl(websiteRaw);

    if (!website) continue;

    process.stdout.write(`[${rowNumber - 1}] ${companyName} -> ${website} ... `);
    const detection = await detectCryptoOnSite(website, args.maxPagesPerSite, args.timeoutMs);
    const entry = {
      companyName,
      website,
      hasCryptoPayment: detection.hasCryptoPayment ? "yes" : "no",
      matchedUrl: detection.matchedUrl || "",
      evidence: detection.evidence || "",
      providerHints: detection.providerHints || "",
      reason: detection.reason || "",
    };

    results.push(entry);
    if (detection.hasCryptoPayment) {
      matched.push(entry);
      console.log("FOUND");
    } else {
      console.log("no");
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  await writeResultWorkbook(args.output, matched);

  const allResultsPath = args.output.replace(/\.xlsx$/i, ".all-results.xlsx");
  await writeResultWorkbook(allResultsPath, results);

  console.log("\nГотово.");
  console.log(`Найдено компаний с crypto-payments: ${matched.length}`);
  console.log(`Файл с совпадениями: ${args.output}`);
  console.log(`Полный отчет: ${allResultsPath}`);
}

main().catch((err) => {
  console.error(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
