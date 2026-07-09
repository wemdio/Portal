import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { extractCoordinatesFromUrl, ensureGoogleMapsLocale } from "../shared/googleMaps";
import { buildDedupeKey, mergeResult } from "../shared/normalize";
import type { JobError, PlaceResult, ScrapeJob, SearchTarget } from "../shared/types";
import { enrichWebsiteContacts } from "./contactEnrichment";

const RESULT_LINK_SELECTOR = 'a[href*="/maps/place/"]';
const FEED_SELECTOR = 'div[role="feed"]';

export interface MapsRunCallbacks {
  onPlaceFound: (place: PlaceResult) => void;
  onProgress: (progress: {
    currentTargetIndex: number;
    processedPlaces: number;
    totalDiscovered: number;
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
  cb: MapsRunCallbacks,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>
): void {
  cb.onLog?.(level, message, meta);
}

export async function runGoogleMapsJob(job: ScrapeJob, cb: MapsRunCallbacks): Promise<void> {
  if (job.targets.length === 0) {
    log(cb, "warn", "No targets to parse — job has empty target list");
    return;
  }

  let browser: Browser | undefined;

  try {
    log(cb, "info", "Launching Chromium", {
      proxy: job.settings.proxies[0] ? "set" : "none",
      targets: job.targets.length
    });
    setStatus(job, cb, "running", "Запускаю Chromium");
    browser = await launchBrowser(job);
    const context = await browser.newContext({
      locale: job.settings.language,
      viewport: { width: 1365, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
    });
    log(cb, "info", "Chromium ready", { locale: job.settings.language });

    for (let index = 0; index < job.targets.length; index += 1) {
      if (cb.shouldStop()) break;
      await waitWhilePaused(cb);

      const target = job.targets[index];
      setCurrentTarget(job, cb, index, `Парсю выдачу: ${target.query}`);
      log(cb, "info", "Opening target", {
        index,
        total: job.targets.length,
        url: target.url,
        query: target.query
      });
      await parseTarget(context, job, cb, target);
    }

    if (cb.shouldStop()) {
      log(cb, "info", "Stop requested — halting");
      setStatus(job, cb, "stopped", "Задача остановлена");
    } else {
      log(cb, "info", "All targets processed", { results: job.results.length });
      setStatus(job, cb, "completed", `Готово: ${job.results.length} уникальных организаций`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Неизвестная ошибка парсера";
    log(cb, "error", `Fatal parser error: ${message}`);
    setStatus(job, cb, "failed", message);
    reportError(job, cb, { message });
  } finally {
    await browser?.close().catch(() => undefined);
    log(cb, "debug", "Chromium closed");
  }
}

async function launchBrowser(job: ScrapeJob): Promise<Browser> {
  const proxy = job.settings.proxies[0];
  return chromium.launch({
    headless: true,
    proxy: proxy ? { server: proxy } : undefined
  });
}

async function parseTarget(context: BrowserContext, job: ScrapeJob, cb: MapsRunCallbacks, target: SearchTarget): Promise<void> {
  const page = await context.newPage();

  try {
    await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await maybeAcceptConsent(page);
    await randomDelay(job);

    if (await isBlocked(page)) {
      log(cb, "error", "Captcha wall detected", { url: page.url(), query: target.query });
      reportError(job, cb, { targetId: target.id, message: `Google вернул блокировку или captcha для ${target.query}` });
      return;
    }

    const links = await collectPlaceLinks(page, job, cb, target);
    log(cb, "info", "Discovered place links", { count: links.length, query: target.query });
    addDiscoveredPlaces(job, cb, links.length);

    for (const link of links.slice(0, job.settings.limitPerQuery)) {
      if (cb.shouldStop()) break;
      await waitWhilePaused(cb);

      const result = await parsePlace(context, job, cb, target, link);
      addResult(job, cb, result);
      await randomDelay(job);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : `Не удалось обработать ${target.query}`;
    log(cb, "error", `Target failed: ${message}`, { query: target.query });
    reportError(job, cb, { targetId: target.id, message });
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function collectPlaceLinks(page: Page, job: ScrapeJob, cb: MapsRunCallbacks, target: SearchTarget): Promise<string[]> {
  const links = new Set<string>();
  let stableRounds = 0;

  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => undefined);
  await page.waitForSelector(`${RESULT_LINK_SELECTOR}, ${FEED_SELECTOR}`, { timeout: 30000 }).catch(() => undefined);

  while (links.size < job.settings.limitPerQuery && stableRounds < 7 && !cb.shouldStop()) {
    await waitWhilePaused(cb);

    const before = links.size;
    for (const href of await page.locator(RESULT_LINK_SELECTOR).evaluateAll((items) => items.map((item) => (item as HTMLAnchorElement).href))) {
      links.add(ensureGoogleMapsLocale(href, job.settings.language, job.settings.region));
    }

    if (links.size === before) stableRounds += 1;
    else stableRounds = 0;

    setStatus(job, cb, "running", `Найдено ${links.size} ссылок для: ${target.query}`);
    await scrollResults(page);
    await randomDelay(job);
  }

  return [...links];
}

async function parsePlace(context: BrowserContext, job: ScrapeJob, cb: MapsRunCallbacks, target: SearchTarget, url: string): Promise<PlaceResult> {
  const page = await context.newPage();
  const placeUrl = ensureGoogleMapsLocale(url, job.settings.language, job.settings.region);

  try {
    await page.goto(placeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => undefined);
    await page.waitForSelector("h1, body", { timeout: 15000 });
    await randomDelay(job);

    if (await isBlocked(page)) {
      log(cb, "error", "Captcha on place page", { url: placeUrl });
      return emptyResult(target, placeUrl, "captcha", "Captcha или блокировка Google Maps");
    }

    const currentUrl = page.url();
    const coordinates = extractCoordinatesFromUrl(currentUrl);
    const name = await firstText(page, ["h1.DUwDvf", "h1"]);
    const address = await itemByDataId(page, "address");
    const phone = await itemByDataId(page, "phone:tel");
    const website = cleanWebsite(await websiteHref(page));
    const category = await categoryText(page);
    const rating = await firstText(page, [".F7nice span[aria-hidden='true']", "[aria-label*='звезд']", "[aria-label*='star']"]);
    const reviewsCount = extractReviewsCount(await firstText(page, [".F7nice span[aria-label]", "[aria-label*='отзыв']", "[aria-label*='review']"]));
    const placeId = extractPlaceId(currentUrl);
    const googleId = extractGoogleId(currentUrl);
    if (job.settings.enrichContacts && website) {
      log(cb, "info", "Enriching website", { url: website });
    }
    const enrichment = job.settings.enrichContacts && website ? await enrichWebsiteContacts(website) : { emails: [], phones: [], socials: [], linkedInUrl: "" };
    if (job.settings.enrichContacts && website) {
      log(cb, "debug", "Website enrichment done", { url: website, foundEmails: enrichment.emails.length });
    }
    log(cb, "debug", "Extracted place", { name, website: website || undefined });

    const result: PlaceResult = {
      query: target.query,
      city: target.city,
      category: target.category || category,
      name,
      address,
      phone: phone || enrichment.phones[0] || "",
      website,
      emails: enrichment.emails,
      socials: enrichment.socials,
      linkedInUrl: enrichment.linkedInUrl,
      rating,
      reviewsCount,
      googleMapsUrl: currentUrl,
      placeId,
      googleId,
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      dedupeKey: "",
      sourceUrl: target.url,
      status: name ? "ok" : "partial"
    };

    return { ...result, dedupeKey: buildDedupeKey(result) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ошибка карточки";
    log(cb, "warn", `Place page error: ${message}`, { url: placeUrl });
    const result = emptyResult(target, placeUrl, "error", message);
    return { ...result, dedupeKey: buildDedupeKey(result) };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function maybeAcceptConsent(page: Page): Promise<void> {
  const labels = ["Принять все", "I agree", "Accept all", "Accept"];
  for (const label of labels) {
    const button = page.getByRole("button", { name: label }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => undefined);
      await page.waitForTimeout(1000);
      return;
    }
  }
}

async function isBlocked(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase();
  if (url.includes("/sorry/") || url.includes("captcha")) return true;
  const body = (await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).toLowerCase();
  return body.includes("unusual traffic") || body.includes("подозрительный трафик") || body.includes("captcha");
}

async function scrollResults(page: Page): Promise<void> {
  const feed = page.locator(FEED_SELECTOR).first();
  if (await feed.isVisible().catch(() => false)) {
    await feed.evaluate((node) => node.scrollTo({ top: node.scrollHeight, behavior: "instant" as ScrollBehavior })).catch(() => undefined);
  } else {
    await page.mouse.wheel(0, 1800).catch(() => undefined);
  }
}

async function itemByDataId(page: Page, dataIdPrefix: string): Promise<string> {
  const locator = page.locator(`[data-item-id^="${dataIdPrefix}"]`).first();
  const label = await locator.getAttribute("aria-label").catch(() => "");
  const text = await locator.innerText().catch(() => "");
  return cleanLabel(label || text);
}

async function websiteHref(page: Page): Promise<string> {
  const direct = await page.locator('a[data-item-id="authority"]').first().getAttribute("href").catch(() => "");
  if (direct) return direct;

  return (
    (await page
      .locator("a")
      .evaluateAll((items) => {
        const candidate = items.find((item) => {
          const label = item.getAttribute("aria-label")?.toLowerCase() ?? "";
          return label.includes("сайт") || label.includes("website");
        });
        return candidate instanceof HTMLAnchorElement ? candidate.href : "";
      })
      .catch(() => "")) || ""
  );
}

async function categoryText(page: Page): Promise<string> {
  const candidates = await page
    .locator("button")
    .evaluateAll((buttons) =>
      buttons
        .map((button) => button.textContent?.trim() ?? "")
        .filter((text) => text.length > 2 && text.length < 80)
        .slice(0, 20)
    )
    .catch(() => []);

  const excluded = ["маршрут", "сохранить", "рядом", "поблизости", "отправить", "поделиться", "directions", "save", "nearby", "send", "share"];
  return candidates.find((text) => !excluded.some((word) => text.toLowerCase().includes(word))) ?? "";
}

async function firstText(page: Page, selectors: string[]): Promise<string> {
  for (const selector of selectors) {
    const text = await page.locator(selector).first().innerText({ timeout: 2500 }).catch(() => "");
    if (text.trim()) return text.trim();
  }
  return "";
}

function cleanLabel(value: string): string {
  return value
    .replace(/^(Адрес|Address|Телефон|Phone|Website|Сайт):\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanWebsite(value: string): string {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (parsed.hostname.includes("google.") && parsed.searchParams.get("q")) {
      return parsed.searchParams.get("q") ?? value;
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function extractReviewsCount(value: string): string {
  const match = value.replace(/\s+/g, " ").match(/[\d\s,.]+/);
  return match ? match[0].trim() : value.trim();
}

function extractPlaceId(url: string): string {
  const match = url.match(/!1s([^!]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function extractGoogleId(url: string): string {
  const match = url.match(/0x[a-f0-9]+:0x[a-f0-9]+/i);
  return match ? match[0] : "";
}

function emptyResult(target: SearchTarget, googleMapsUrl: string, status: PlaceResult["status"], error: string): PlaceResult {
  const coordinates = extractCoordinatesFromUrl(googleMapsUrl);
  return {
    query: target.query,
    city: target.city,
    category: target.category,
    name: "",
    address: "",
    phone: "",
    website: "",
    emails: [],
    socials: [],
    linkedInUrl: "",
    rating: "",
    reviewsCount: "",
    googleMapsUrl,
    placeId: extractPlaceId(googleMapsUrl),
    googleId: extractGoogleId(googleMapsUrl),
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    dedupeKey: "",
    sourceUrl: target.url,
    status,
    error
  };
}

async function randomDelay(job: ScrapeJob): Promise<void> {
  const min = job.settings.minDelayMs;
  const max = Math.max(min, job.settings.maxDelayMs);
  const delay = min + Math.round(Math.random() * (max - min));
  await new Promise((resolve) => setTimeout(resolve, delay));
}

function setStatus(job: ScrapeJob, cb: MapsRunCallbacks, status: ScrapeJob["status"], message: string): void {
  job.status = status;
  job.message = message;
  job.updatedAt = new Date().toISOString();
  cb.onProgress({
    currentTargetIndex: job.currentTargetIndex,
    processedPlaces: job.processedPlaces,
    totalDiscovered: job.totalDiscovered,
    message
  });
}

function setCurrentTarget(job: ScrapeJob, cb: MapsRunCallbacks, index: number, message: string): void {
  job.currentTargetIndex = index;
  job.message = message;
  job.updatedAt = new Date().toISOString();
  cb.onProgress({
    currentTargetIndex: index,
    processedPlaces: job.processedPlaces,
    totalDiscovered: job.totalDiscovered,
    message
  });
}

function addDiscoveredPlaces(job: ScrapeJob, cb: MapsRunCallbacks, count: number): void {
  job.totalDiscovered += count;
  job.updatedAt = new Date().toISOString();
  cb.onProgress({
    currentTargetIndex: job.currentTargetIndex,
    processedPlaces: job.processedPlaces,
    totalDiscovered: job.totalDiscovered,
    message: job.message
  });
}

function addResult(job: ScrapeJob, cb: MapsRunCallbacks, result: PlaceResult): void {
  const dedupeKey = result.dedupeKey || buildDedupeKey(result);
  const normalizedResult: PlaceResult = { ...result, dedupeKey };
  const existingIndex = dedupeKey ? job.results.findIndex((item) => item.dedupeKey === dedupeKey) : -1;

  if (existingIndex >= 0) {
    job.results[existingIndex] = mergeResult(job.results[existingIndex], normalizedResult);
  } else {
    job.results.push(normalizedResult);
  }

  job.processedPlaces += 1;
  job.updatedAt = new Date().toISOString();
  cb.onPlaceFound(normalizedResult);
}

function reportError(job: ScrapeJob, cb: MapsRunCallbacks, error: Omit<JobError, "at">): void {
  const record: JobError = { ...error, at: new Date().toISOString() };
  job.errors.push(record);
  job.updatedAt = new Date().toISOString();
  cb.onError(record);
}

async function waitWhilePaused(cb: MapsRunCallbacks): Promise<void> {
  while (cb.shouldPause() && !cb.shouldStop()) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
