import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { NewsResult, NewsTarget } from "../shared/types";
import {
  addNewsError,
  addNewsResult,
  persistNewsJob,
  setCurrentNewsTarget,
  setNewsJobStatus,
  waitWhileNewsPaused,
  type RuntimeNewsJob
} from "../newsJobStore";
import { fetchGoogleNewsRssResults } from "./googleNewsRss";

interface ExtractedNewsItem {
  title: string;
  body: string;
  posted: string;
  source: string;
  link: string;
}

type ParseTargetResult = "ok" | "exhausted" | "terminal";

export async function runGoogleNewsJob(job: RuntimeNewsJob): Promise<void> {
  if (job.targets.length === 0) return;

  let browser: Browser | undefined;

  try {
    setNewsJobStatus(job, "running", "Starting Chromium for Google News");
    browser = await launchBrowser(job);
    const context = await browser.newContext({
      locale: `${job.settings.language}-${job.settings.country}`,
      viewport: { width: 1365, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
    });
    const exhaustedQueries = new Set<string>();

    for (let index = 0; index < job.targets.length; index += 1) {
      if (job.control.stopRequested) break;
      await waitWhileNewsPaused(job);

      const target = job.targets[index];
      if (exhaustedQueries.has(target.query)) {
        setCurrentNewsTarget(job, index, `Skipping exhausted query: ${target.query} / page ${target.page}`);
        continue;
      }

      setCurrentNewsTarget(job, index, `Parsing Google News: ${target.query} / page ${target.page}`);
      const result = await parseNewsTarget(context, job, target);
      if (result === "exhausted") exhaustedQueries.add(target.query);
      await persistNewsJob(job);

      if (result === "terminal" || job.status === "captcha" || job.status === "blocked" || job.status === "timeout") break;
    }

    if (job.status === "captcha" || job.status === "blocked" || job.status === "timeout") {
      // Keep the explicit Google protection status instead of overwriting it with "stopped".
    } else if (job.control.stopRequested) {
      setNewsJobStatus(job, "stopped", "News job stopped");
    } else if ((job.status === "running" || job.status === "queued") && job.results.length === 0 && job.errors.length > 0) {
      setNewsJobStatus(job, "failed", "No news results collected");
    } else if (job.status === "running" || job.status === "queued") {
      setNewsJobStatus(job, "completed", `Done: ${job.results.length} news results`);
    }
    await persistNewsJob(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Google News parser error";
    setNewsJobStatus(job, message.toLowerCase().includes("timeout") ? "timeout" : "failed", message);
    await addNewsError(job, { message });
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function launchBrowser(job: RuntimeNewsJob): Promise<Browser> {
  const proxy = job.settings.proxies[0];
  return chromium.launch({
    headless: true,
    proxy: proxy ? { server: proxy } : undefined
  });
}

async function parseNewsTarget(context: BrowserContext, job: RuntimeNewsJob, target: NewsTarget): Promise<ParseTargetResult> {
  const rssCount = await addRssFallbackResults(job, target, "RSS parsing").catch(async (error) => {
    if (target.page > 1 || hasResultsForQuery(job, target.query)) {
      await addNewsError(job, {
        targetId: target.id,
        message: error instanceof Error ? `RSS failed for ${target.query}: ${error.message}` : `RSS failed for ${target.query}`
      });
      return 0;
    }
    return -1;
  });

  if (rssCount > 0) return "ok";
  if (rssCount === 0 && hasResultsForQuery(job, target.query)) {
    setNewsJobStatus(job, "running", `No more RSS results for ${target.query}`);
    return "exhausted";
  }
  if (rssCount === 0 && target.page > 1) {
    setNewsJobStatus(job, "running", `No RSS results for ${target.query} / page ${target.page}`);
    return "exhausted";
  }

  const page = await context.newPage();
  try {
    await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await maybeHandleConsent(page);
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => undefined);
    await randomDelay(job);

    const blockReason = await detectBlockReason(page);
    if (blockReason) {
      const fallbackCount = await addRssFallbackResults(job, target, `HTML ${blockReason}, RSS fallback`);
      if (fallbackCount === 0) {
        await addNewsError(job, { targetId: target.id, message: `${blockReason} for ${target.query}` });
        setNewsJobStatus(job, blockReason === "captcha" ? "captcha" : "blocked", `${blockReason} while parsing Google News`);
        job.control.stopRequested = true;
        return "terminal";
      }
      return "ok";
    }

    const items = await extractNewsItems(page);
    if (items.length === 0) {
      const fallbackCount = await addRssFallbackResults(job, target, "No HTML results, RSS fallback");
      if (fallbackCount === 0) {
        await addNewsError(job, { targetId: target.id, message: `No news results found for ${target.query}` });
      }
      return fallbackCount > 0 ? "ok" : "exhausted";
    }

    const pageOffset = (target.page - 1) * 10;
    for (let index = 0; index < items.length; index += 1) {
      if (job.control.stopRequested) break;
      await waitWhileNewsPaused(job);

      const result: NewsResult = {
        query: target.query,
        position: pageOffset + index + 1,
        title: items[index].title,
        body: items[index].body,
        posted: items[index].posted,
        source: items[index].source,
        link: items[index].link
      };
      await addNewsResult(job, result);
    }

    setNewsJobStatus(job, "running", `Collected ${items.length} results for ${target.query} / page ${target.page}`);
    return "ok";
  } catch (error) {
    const message = error instanceof Error ? error.message : `Could not parse ${target.query}`;
    const fallbackCount = await addRssFallbackResults(job, target, "HTML parser error, RSS fallback").catch(async (fallbackError) => {
      await addNewsError(job, {
        targetId: target.id,
        message: fallbackError instanceof Error ? `${message}; RSS fallback failed: ${fallbackError.message}` : message
      });
      return 0;
    });
    if (fallbackCount === 0 && message.toLowerCase().includes("timeout")) {
      setNewsJobStatus(job, "timeout", message);
      job.control.stopRequested = true;
      return "terminal";
    } else if (fallbackCount === 0) {
      await addNewsError(job, { targetId: target.id, message });
      return hasResultsForQuery(job, target.query) ? "exhausted" : "ok";
    }
    return "ok";
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function addRssFallbackResults(job: RuntimeNewsJob, target: NewsTarget, reason: string): Promise<number> {
  setNewsJobStatus(job, "running", `${reason}: ${target.query} / page ${target.page}`);
  const results = await fetchGoogleNewsRssResults(job.settings, target);

  for (const result of results) {
    if (job.control.stopRequested) break;
    await waitWhileNewsPaused(job);
    await addNewsResult(job, result);
  }

  if (results.length > 0) {
    setNewsJobStatus(job, "running", `RSS fallback collected ${results.length} results for ${target.query} / page ${target.page}`);
  }

  return results.length;
}

function hasResultsForQuery(job: RuntimeNewsJob, query: string): boolean {
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

async function randomDelay(job: RuntimeNewsJob): Promise<void> {
  const min = job.settings.minDelayMs;
  const max = Math.max(min, job.settings.maxDelayMs);
  const delay = min + Math.round(Math.random() * (max - min));
  await new Promise((resolve) => setTimeout(resolve, delay));
}
