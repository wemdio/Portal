import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildGoogleNewsRssUrl } from "../shared/googleNews";
import type { NewsResult, NewsScrapeSettings, NewsTarget } from "../shared/types";

interface RssItem {
  title: string;
  description: string;
  posted: string;
  source: string;
  link: string;
}

const RESULTS_PER_PAGE = 10;
const execFileAsync = promisify(execFile);
type FetchLikeResponse = Pick<Response, "ok" | "status" | "text">;

export async function fetchGoogleNewsRssResults(settings: NewsScrapeSettings, target: NewsTarget): Promise<NewsResult[]> {
  const url = buildGoogleNewsRssUrl(target.query, settings.language, settings.country, settings.dateRange);
  const response = await fetchWithTimeout(url, 25000);
  if (!response.ok) {
    throw new Error(`Google News RSS returned ${response.status}`);
  }

  const xml = await response.text();
  const items = parseRssItems(xml);
  const offset = (target.page - 1) * RESULTS_PER_PAGE;
  const pageItems = items.slice(offset, offset + RESULTS_PER_PAGE);

  return Promise.all(
    pageItems.map(async (item, index) => {
      const link = await resolveGoogleNewsLink(item.link).catch(() => item.link);
      const body = await extractArticleDescription(link).catch(() => "") || rssBody(item);

      return {
        query: target.query,
        position: offset + index + 1,
        title: item.title,
        body,
        posted: item.posted,
        source: item.source,
        link
      };
    })
  );
}

function parseRssItems(xml: string): RssItem[] {
  return Array.from(xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)).map((match) => {
    const itemXml = match[1];
    const title = textTag(itemXml, "title");
    const description = textTag(itemXml, "description");
    const link = textTag(itemXml, "link");
    const pubDate = textTag(itemXml, "pubDate");
    const source = textTag(itemXml, "source");

    return {
      title,
      description,
      posted: formatPosted(pubDate),
      source,
      link
    };
  });
}

async function resolveGoogleNewsLink(link: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    return link;
  }

  if (!parsed.hostname.includes("news.google.") || !parsed.pathname.includes("/articles/")) {
    return link;
  }

  const articleId = parsed.pathname.split("/").filter(Boolean).pop();
  if (!articleId) return link;

  const payload = [
    [
      [
        "Fbv4je",
        JSON.stringify([
          "garturlreq",
          [["en-US", "US", ["FINANCE_TOP_INDICES", "WEB_TEST_1_0_0"], null, null, 1, 1, "US:en", null, 180, null, null, null, null, null, 0, null, null, [1608992183, 723341000]], "en-US", "US", 1, [2, 3, 4, 8], 1, 0, "655000234", 0, 0, null, 0],
          articleId
        ]),
        null,
        "generic"
      ]
    ]
  ];

  const response = await fetchWithTimeout("https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je", 12000, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
      referer: "https://news.google.com/"
    },
    body: `f.req=${encodeURIComponent(JSON.stringify(payload))}`
  });

  if (!response.ok) return link;
  const text = await response.text();
  const decoded = extractDecodedUrl(text);
  return decoded || link;
}

function extractDecodedUrl(value: string): string {
  const header = '["garturlres","';
  const start = value.indexOf(header);
  if (start < 0) return "";

  const rest = value.slice(start + header.length);
  const end = rest.indexOf('",');
  if (end < 0) return "";

  return rest
    .slice(0, end)
    .replace(/\\u003d/g, "=")
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"');
}

async function extractArticleDescription(link: string): Promise<string> {
  if (!/^https?:\/\//i.test(link) || new URL(link).hostname.includes("news.google.")) return "";
  const response = await fetchWithTimeout(link, 8000, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
    }
  });
  if (!response.ok) return "";

  const html = await response.text();
  return (
    metaContent(html, "description") ||
    metaContent(html, "og:description") ||
    metaContent(html, "twitter:description")
  );
}

function metaContent(html: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`, "i")
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return cleanText(decodeXml(match[1]));
  }

  return "";
}

function rssBody(item: RssItem): string {
  const stripped = stripHtml(item.description)
    .replace(item.title, "")
    .replace(item.source, "")
    .trim();
  return stripped || item.title;
}

function textTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1] ? cleanText(decodeXml(match[1])) : "";
}

function stripHtml(value: string): string {
  return cleanText(decodeXml(value.replace(/<[^>]*>/g, " ")));
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatPosted(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const diffMs = Date.now() - date.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs >= 0 && diffMs < hour) return `${Math.max(1, Math.round(diffMs / minute))} minutes ago`;
  if (diffMs >= 0 && diffMs < day) return `${Math.max(1, Math.round(diffMs / hour))} hours ago`;
  if (diffMs >= 0 && diffMs < 45 * day) return `${Math.max(1, Math.round(diffMs / day))} days ago`;
  if (diffMs >= 0 && diffMs < 60 * day) return "1 month ago";

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
}

async function fetchWithTimeout(url: string, timeoutMs: number, init: RequestInit = {}): Promise<FetchLikeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal
      });
    } catch (error) {
      if ((init.method ?? "GET").toUpperCase() !== "GET" || process.platform !== "win32") {
        throw error;
      }
      return await fetchWithPowerShell(url, timeoutMs);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithPowerShell(url: string, timeoutMs: number): Promise<FetchLikeResponse> {
  const command = [
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;",
    "$ProgressPreference='SilentlyContinue';",
    "(Invoke-WebRequest -UseBasicParsing -Uri $env:CODEX_FETCH_URL -TimeoutSec $env:CODEX_FETCH_TIMEOUT).Content"
  ].join(" ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_FETCH_TIMEOUT: String(Math.ceil(timeoutMs / 1000)),
      CODEX_FETCH_URL: url
    },
    maxBuffer: 20 * 1024 * 1024,
    timeout: timeoutMs + 5000
  });

  return {
    ok: true,
    status: 200,
    text: async () => stdout
  };
}
