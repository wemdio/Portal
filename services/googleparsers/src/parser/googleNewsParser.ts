import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { JobError, NewsJob, NewsResult, NewsTarget } from "../shared/types";
import { fetchGoogleNewsRssResults } from "./googleNewsRss";

interface ExtractedNewsItem {
  title: string;
  body: string;
  posted: string;
  source: string;
  link: string;
}

type ParseTargetResult = "ok" | "exhausted" | "terminal";

export interface NewsRunCallbacks {
  onResult: (result: NewsResult) => void;
  onProgress: (progress: {
    currentTargetIndex: number;
    processedResults: number;
    message: string;
  }) => void;
  onError: (error: JobError) => void;
  onLog?: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>
  ) => void;
  shouldPause: () => boolean;
  shouldStop: () => boolean;
}

function log(
  cb: NewsRunCallbacks,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>
): void {
  cb.onLog?.(level, message, meta);
}

export async function runGoogleNewsJob(job: NewsJob, cb: NewsRunCallbacks): Promise<void> {
  if (job.targets.length === 0) {
    log(cb, "warn", "No targets to parse — job has empty target list");
    return;
  }

  let browser: Browser | undefined;
  let stopRequestedInternally = false;
  const isStopped = (): boolean => stopRequestedInternally || cb.shouldStop();

  try {
    log(cb, "info", "Launching Chromium", {
      proxy: job.settings.proxies[0] ? "set" : "none",
      targets: job.targets.length
    });
    setStatus(job, cb, "running", "Starting Chromium for Google News");
    browser = await launchBrowser(job);
    const context = await browser.newContext({
      locale: `${job.settings.language}-${job.settings.country}`,
      viewport: { width: 1365, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
    });
    log(cb, "info", "Chromium ready", { locale: `${job.settings.language}-${job.settings.country}` });
    const exhaustedQueries = new Set<string>();

    for (let index = 0; index < job.targets.length; index += 1) {
      if (isStopped()) break;
      await waitWhilePaused(cb);

      const target = job.targets[index];
      if (exhaustedQueries.has(target.query)) {
        setCurrentTarget(job, cb, index, `Skipping exhausted query: ${target.query} / page ${target.page}`);
        continue;
      }

      setCurrentTarget(job, cb, index, `Parsing Google News: ${target.query} / page ${target.page}`);
      log(cb, "info", "Opening target", {
        index,
        total: job.targets.length,
        query: target.query,
        page: target.page
      });
      const result = await parseNewsTarget(context, job, cb, target, () => {
        stopRequestedInternally = true;
      }, isStopped);
      if (result === "exhausted") exhaustedQueries.add(target.query);

      if (result === "terminal" || job.status === "captcha" || job.status === "blocked" || job.status === "timeout") break;
    }

    if (job.status === "captcha" || job.status === "blocked" || job.status === "timeout") {
      // Keep the explicit Google protection status instead of overwriting it with "stopped".
      log(cb, "warn", `Job halted by Google protection: ${job.status}`);
    } else if (isStopped()) {
      log(cb, "info", "Stop requested — halting");
      setStatus(job, cb, "stopped", "News job stopped");
    } else if ((job.status === "running" || job.status === "queued") && job.results.length === 0 && job.errors.length > 0) {
      log(cb, "warn", "No results collected despite errors");
      setStatus(job, cb, "failed", "No news results collected");
    } else if (job.status === "running" || job.status === "queued") {
      log(cb, "info", "All targets processed", { results: job.results.length });
      setStatus(job, cb, "completed", `Done: ${job.results.length} news results`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Google News parser error";
    log(cb, "error", `Fatal parser error: ${message}`);
    setStatus(job, cb, message.toLowerCase().includes("timeout") ? "timeout" : "failed", message);
    reportError(job, cb, { message });
  } finally {
    await browser?.close().catch(() => undefined);
    log(cb, "debug", "Chromium closed");
  }
}

async function launchBrowser(job: NewsJob): Promise<Browser> {
  // Random pick из пула — см. googleMapsParser.launchBrowser.
  const pool = job.settings.proxies ?? [];
  const proxy = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : undefined;
  return chromium.launch({
    headless: true,
    proxy: proxy ? { server: proxy } : undefined
  });
}

/**
 * Navigate with a longer timeout + fallback wait strategy. Same reasoning as
 * googleMapsParser.gotoWithRetry — Google News' DOMContentLoaded stalls under
 * a slow proxy; falling back to `load` wait gives Chromium more room to settle
 * before we start looking for selectors.
 */
async function gotoWithRetry(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("Timeout")) throw err;
    await page.goto(url, { waitUntil: "load", timeout: 90000 });
  }
}

async function parseNewsTarget(
  context: BrowserContext,
  job: NewsJob,
  cb: NewsRunCallbacks,
  target: NewsTarget,
  requestStop: () => void,
  isStopped: () => boolean
): Promise<ParseTargetResult> {
  const rssCount = await addRssFallbackResults(job, cb, target, "RSS parsing", isStopped).catch(async (error) => {
    if (target.page > 1 || hasResultsForQuery(job, target.query)) {
      reportError(job, cb, {
        targetId: target.id,
        message: error instanceof Error ? `RSS failed for ${target.query}: ${error.message}` : `RSS failed for ${target.query}`
      });
      return 0;
    }
    return -1;
  });

  if (rssCount > 0) return "ok";
  if (rssCount === 0 && hasResultsForQuery(job, target.query)) {
    setStatus(job, cb, "running", `No more RSS results for ${target.query}`);
    return "exhausted";
  }
  if (rssCount === 0 && target.page > 1) {
    setStatus(job, cb, "running", `No RSS results for ${target.query} / page ${target.page}`);
    return "exhausted";
  }

  const page = await context.newPage();
  try {
    await gotoWithRetry(page, target.url);
    await maybeHandleConsent(page);
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => undefined);
    await randomDelay(job);

    const blockReason = await detectBlockReason(page);
    if (blockReason) {
      log(cb, "error", `Google protection detected: ${blockReason}`, {
        query: target.query,
        page: target.page,
        url: page.url()
      });
      const fallbackCount = await addRssFallbackResults(job, cb, target, `HTML ${blockReason}, RSS fallback`, isStopped);
      if (fallbackCount === 0) {
        reportError(job, cb, { targetId: target.id, message: `${blockReason} for ${target.query}` });
        setStatus(job, cb, blockReason === "captcha" ? "captcha" : "blocked", `${blockReason} while parsing Google News`);
        requestStop();
        return "terminal";
      }
      return "ok";
    }

    const items = await extractNewsItems(page);
    if (items.length === 0) {
      const fallbackCount = await addRssFallbackResults(job, cb, target, "No HTML results, RSS fallback", isStopped);
      if (fallbackCount === 0) {
        reportError(job, cb, { targetId: target.id, message: `No news results found for ${target.query}` });
      }
      return fallbackCount > 0 ? "ok" : "exhausted";
    }

    const pageOffset = (target.page - 1) * 10;
    for (let index = 0; index < items.length; index += 1) {
      if (isStopped()) break;
      await waitWhilePaused(cb);

      const result: NewsResult = {
        query: target.query,
        position: pageOffset + index + 1,
        title: items[index].title,
        body: items[index].body,
        posted: items[index].posted,
        source: items[index].source,
        link: items[index].link
      };
      addNewsResult(job, cb, result);
    }

    setStatus(job, cb, "running", `Collected ${items.length} results for ${target.query} / page ${target.page}`);
    return "ok";
  } catch (error) {
    const message = error instanceof Error ? error.message : `Could not parse ${target.query}`;
    const fallbackCount = await addRssFallbackResults(job, cb, target, "HTML parser error, RSS fallback", isStopped).catch(async (fallbackError) => {
      reportError(job, cb, {
        targetId: target.id,
        message: fallbackError instanceof Error ? `${message}; RSS fallback failed: ${fallbackError.message}` : message
      });
      return 0;
    });
    if (fallbackCount === 0 && message.toLowerCase().includes("timeout")) {
      setStatus(job, cb, "timeout", message);
      requestStop();
      return "terminal";
    } else if (fallbackCount === 0) {
      reportError(job, cb, { targetId: target.id, message });
      return hasResultsForQuery(job, target.query) ? "exhausted" : "ok";
    }
    return "ok";
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function addRssFallbackResults(
  job: NewsJob,
  cb: NewsRunCallbacks,
  target: NewsTarget,
  reason: string,
  isStopped: () => boolean
): Promise<number> {
  setStatus(job, cb, "running", `${reason}: ${target.query} / page ${target.page}`);
  log(cb, "info", `RSS fetch: ${reason}`, { query: target.query, page: target.page });
  const results = await fetchGoogleNewsRssResults(job.settings, target);
  log(cb, "info", "RSS results received", {
    query: target.query,
    page: target.page,
    count: results.length
  });

  for (const result of results) {
    if (isStopped()) break;
    await waitWhilePaused(cb);
    addNewsResult(job, cb, result);
  }

  if (results.length > 0) {
    setStatus(job, cb, "running", `RSS fallback collected ${results.length} results for ${target.query} / page ${target.page}`);
  }

  return results.length;
}

function hasResultsForQuery(job: NewsJob, query: string): boolean {
  return job.results.some((result) => result.query === query);
}

async function maybeHandleConsent(page: Page): Promise<void> {
  const labels = ["Reject all", "Accept all", "I agree", "Accept", "Принять все", "Отклонить все"];
  for (const label of labels) {
    const button = page.getByRole("button", { name: label }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => undefined);
      await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => undefined);
      await page.waitForTimeout(1000);
      return;
    }
  }

  const formButton = page.locator('form button, input[type="submit"]').first();
  if (await formButton.isVisible().catch(() => false)) {
    await formButton.click().catch(() => undefined);
    await page.waitForTimeout(1000);
  }
}

async function detectBlockReason(page: Page): Promise<"captcha" | "blocked" | ""> {
  const url = page.url().toLowerCase();
  if (url.includes("/sorry/") || url.includes("captcha")) return "captcha";
  const body = (await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).toLowerCase();
  if (body.includes("captcha")) return "captcha";
  if (body.includes("unusual traffic") || body.includes("our systems have detected") || body.includes("automated queries")) return "blocked";
  return "";
}

async function extractNewsItems(page: Page): Promise<ExtractedNewsItem[]> {
  return page.evaluate(() => {
    type Item = {
      title: string;
      body: string;
      posted: string;
      source: string;
      link: string;
    };

    const resultSelectors = ["div.SoaBEf", "div.dbsr", "article", "div[data-news-cluster-id]", "div.MjjYud"];
    const nodes = uniqueElements(resultSelectors.flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector))));
    const items: Item[] = [];
    const seenLinks = new Set<string>();

    for (const node of nodes) {
      const link = normalizeLink(firstUsableLink(node));
      if (!link || seenLinks.has(link)) continue;

      const title =
        firstText(node, ["div.n0jPhd", "div.MBeuO", "h3", '[role="heading"]', "a"]) ||
        firstMeaningfulLine(node.innerText);
      if (!title || title.length < 5) continue;

      const body = firstText(node, ["div.GI74Re", "div.Y3v8qd", "div.VwiC3b", "div[style*='-webkit-line-clamp']"]);
      const posted = firstText(node, ["div.OSrXXb span", "span.WG9SHc", "span[aria-label*='ago']", "span[aria-label*='hour']", "span[aria-label*='day']"]) || findDateLine(node.innerText);
      const source = firstText(node, ["div.NUnG9d span", "span.NUnG9d", "div.CEMjEf span", "g-img + span"]) || findSourceLine(node.innerText, title, body, posted);

      items.push({
        title: clean(title),
        body: clean(body),
        posted: clean(posted),
        source: clean(source),
        link
      });
      seenLinks.add(link);
    }

    return items.slice(0, 10);

    function uniqueElements(elements: HTMLElement[]): HTMLElement[] {
      return elements.filter((element, index) => elements.findIndex((candidate) => candidate === element || candidate.contains(element)) === index);
    }

    function firstUsableLink(root: HTMLElement): string {
      const anchors = Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"));
      for (const anchor of anchors) {
        const href = anchor.href || anchor.getAttribute("href") || "";
        const text = anchor.innerText.trim();
        if (!href || !text) continue;
        const normalized = normalizeLink(href);
        if (normalized) return normalized;
      }
      return "";
    }

    function normalizeLink(href: string): string {
      try {
        const url = new URL(href, window.location.href);
        if (url.hostname.includes("google.")) {
          const direct = url.searchParams.get("q") || url.searchParams.get("url");
          if (direct) return direct;
          if (url.pathname.startsWith("/url")) return "";
          if (url.pathname.startsWith("/search")) return "";
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") return "";
        return url.toString();
      } catch {
        return "";
      }
    }

    function firstText(root: HTMLElement, selectors: string[]): string {
      for (const selector of selectors) {
        const element = root.querySelector<HTMLElement>(selector);
        const text = element?.innerText?.trim();
        if (text) return text;
      }
      return "";
    }

    function firstMeaningfulLine(value: string): string {
      return lines(value).find((line) => line.length > 5) || "";
    }

    function findDateLine(value: string): string {
      return (
        lines(value).find((line) =>
          /\b(ago|hour|hours|day|days|week|weeks|month|months|year|years|minute|minutes|yesterday)\b/i.test(line)
        ) || ""
      );
    }

    function findSourceLine(value: string, title: string, body: string, posted: string): string {
      return (
        lines(value).find((line) => {
          if (!line || line === title || line === body || line === posted) return false;
          if (line.length > 80) return false;
          return !/\b(ago|hour|hours|day|days|week|weeks|month|months|year|years|minute|minutes)\b/i.test(line);
        }) || ""
      );
    }

    function lines(value: string): string[] {
      return value
        .split(/\n+/)
        .map((line) => clean(line))
        .filter(Boolean);
    }

    function clean(value: string): string {
      return value.replace(/\s+/g, " ").trim();
    }
  });
}

async function randomDelay(job: NewsJob): Promise<void> {
  const min = job.settings.minDelayMs;
  const max = Math.max(min, job.settings.maxDelayMs);
  const delay = min + Math.round(Math.random() * (max - min));
  await new Promise((resolve) => setTimeout(resolve, delay));
}

function setStatus(job: NewsJob, cb: NewsRunCallbacks, status: NewsJob["status"], message: string): void {
  job.status = status;
  job.message = message;
  job.updatedAt = new Date().toISOString();
  cb.onProgress({
    currentTargetIndex: job.currentTargetIndex,
    processedResults: job.processedResults,
    message
  });
}

function setCurrentTarget(job: NewsJob, cb: NewsRunCallbacks, index: number, message: string): void {
  job.currentTargetIndex = index;
  job.message = message;
  job.updatedAt = new Date().toISOString();
  cb.onProgress({
    currentTargetIndex: index,
    processedResults: job.processedResults,
    message
  });
}

function addNewsResult(job: NewsJob, cb: NewsRunCallbacks, result: NewsResult): void {
  job.results.push(result);
  job.processedResults += 1;
  job.updatedAt = new Date().toISOString();
  cb.onResult(result);
}

function reportError(job: NewsJob, cb: NewsRunCallbacks, error: Omit<JobError, "at">): void {
  const record: JobError = { ...error, at: new Date().toISOString() };
  job.errors.push(record);
  job.updatedAt = new Date().toISOString();
  cb.onError(record);
}

async function waitWhilePaused(cb: NewsRunCallbacks): Promise<void> {
  while (cb.shouldPause() && !cb.shouldStop()) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
