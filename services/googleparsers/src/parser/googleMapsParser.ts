import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { runConcurrentPool } from "../shared/concurrency";
import { extractCoordinatesFromUrl, ensureGoogleMapsLocale } from "../shared/googleMaps";
import { buildDedupeKey, mergeResult } from "../shared/normalize";
import { maskProxy, shuffledUniqueProxies, toPlaywrightProxy } from "../shared/proxy";
import type { JobError, PlaceResult, ScrapeJob, SearchTarget } from "../shared/types";
import { enrichWebsiteContacts } from "./contactEnrichment";

const RESULT_LINK_SELECTOR = 'a[href*="/maps/place/"]';
const FEED_SELECTOR = 'div[role="feed"]';
const PLACE_TITLE_SELECTOR = "h1.DUwDvf, h1.fontHeadlineLarge";
const MAPS_READY_SELECTOR = `${RESULT_LINK_SELECTOR}, ${FEED_SELECTOR}, ${PLACE_TITLE_SELECTOR}`;
const GOOGLE_CONNECTIVITY_URL = "https://www.google.com/robots.txt";
const NAVIGATION_TIMEOUT_MS = 30_000;
const MAPS_READY_TIMEOUT_MS = 35_000;
const PAGE_OPERATION_TIMEOUT_MS = 10_000;
const DEFAULT_PLACE_CONCURRENCY = 4;
const MAX_PLACE_CONCURRENCY = 6;

type BrowserSession = {
  browser: Browser;
  context: BrowserContext;
  proxy?: string;
};

type ParseTargetOutcome =
  | { ok: true }
  | { ok: false; retryable: boolean; message: string };

class TargetLoadError extends Error {}

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

  let session: BrowserSession | undefined;
  const rejectedProxies = new Set<string>();

  try {
    log(cb, "info", "Launching Chromium", {
      proxy: job.settings.proxies[0] ? "set" : "none",
      targets: job.targets.length
    });
    setStatus(job, cb, "running", "Запускаю Chromium");
    session = await launchBrowserSession(job, cb, rejectedProxies);

    for (let index = 0; index < job.targets.length; index += 1) {
      if (cb.shouldStop()) break;
      await waitWhilePaused(cb);

      const target = job.targets[index];
      setCurrentTarget(job, cb, index, `Парсю выдачу: ${target.query}`);
      while (!cb.shouldStop()) {
        log(cb, "info", "Opening target", {
          index,
          total: job.targets.length,
          url: target.url,
          query: target.query,
          proxy: maskProxy(session.proxy)
        });
        const outcome = await parseTarget(session.context, job, cb, target);
        if (outcome.ok) break;

        const canRotate = Boolean(session.proxy)
          && rejectedProxies.size + 1 < new Set(job.settings.proxies).size;
        if (!outcome.retryable || !canRotate) {
          reportError(job, cb, { targetId: target.id, message: outcome.message });
          break;
        }

        rejectedProxies.add(session.proxy!);
        log(cb, "warn", "Google Maps did not load; rotating proxy", {
          proxy: maskProxy(session.proxy),
          query: target.query,
          reason: outcome.message
        });
        await closeBrowserSession(session);
        session = await launchBrowserSession(job, cb, rejectedProxies);
      }
    }

    if (cb.shouldStop()) {
      log(cb, "info", "Stop requested — halting");
      setStatus(job, cb, "stopped", "Задача остановлена");
    } else if (job.results.length === 0 && job.errors.length > 0) {
      log(cb, "warn", "No places collected despite target errors", { errors: job.errors.length });
      setStatus(job, cb, "failed", "Не удалось загрузить выдачу Google Maps");
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
    if (session) await closeBrowserSession(session);
    log(cb, "debug", "Chromium closed");
  }
}

async function launchBrowserSession(
  job: ScrapeJob,
  cb: MapsRunCallbacks,
  rejectedProxies: Set<string>
): Promise<BrowserSession> {
  const configured = shuffledUniqueProxies(job.settings.proxies ?? []);
  const candidates: Array<string | undefined> = configured.length > 0
    ? configured.filter((proxy) => !rejectedProxies.has(proxy))
    : [undefined];
  let lastError = "";

  for (const proxy of candidates) {
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({
        headless: true,
        proxy: toPlaywrightProxy(proxy),
        args: [
          "--disable-blink-features=AutomationControlled",
          "--disable-quic",
          "--disable-http2",
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--lang=ru-RU,ru,en-US,en"
        ]
      });
      const locale = mapsLocale(job.settings.language, job.settings.region);
      const context = await browser.newContext({
        locale,
        viewport: { width: 1365, height: 900 },
        serviceWorkers: "block",
        userAgent: chromiumUserAgent(browser)
      });
      context.setDefaultTimeout(PAGE_OPERATION_TIMEOUT_MS);
      context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });
      await verifyGoogleConnectivity(context);
      log(cb, "info", "Chromium ready", {
        locale,
        proxy: maskProxy(proxy),
        chromium: browser.version()
      });
      return { browser, context, proxy };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (proxy) rejectedProxies.add(proxy);
      log(cb, "warn", "Proxy check failed; trying another proxy", {
        proxy: maskProxy(proxy),
        reason: firstLine(lastError)
      });
      if (browser) await closeBrowser(browser);
    }
  }

  const suffix = lastError ? `: ${firstLine(lastError)}` : "";
  throw new Error(`Ни один прокси не смог подключиться к Google${suffix}`);
}

async function verifyGoogleConnectivity(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  try {
    const response = await page.goto(GOOGLE_CONNECTIVITY_URL, {
      waitUntil: "commit",
      timeout: 15_000
    });
    const status = response?.status() ?? 0;
    if (status === 407) throw new Error("прокси отклонил логин или пароль (HTTP 407)");
    if (status === 0 || status >= 400) throw new Error(`Google вернул HTTP ${status || "без ответа"}`);
  } finally {
    await closePage(page);
  }
}

function mapsLocale(language: string, region: string): string {
  const normalizedLanguage = (language || "ru").toLowerCase();
  if (normalizedLanguage.includes("-")) return normalizedLanguage;
  return `${normalizedLanguage}-${(region || "RU").toUpperCase()}`;
}

function chromiumUserAgent(browser: Browser): string {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
}

/**
 * Maps is a long-lived SPA and may never reach DOMContentLoaded through a slow
 * proxy. A committed response plus a real Maps surface is the useful signal.
 */
async function gotoMaps(page: Page, url: string): Promise<void> {
  const response = await page.goto(url, {
    waitUntil: "commit",
    timeout: NAVIGATION_TIMEOUT_MS
  });
  const status = response?.status() ?? 0;
  if (status === 407) throw new TargetLoadError("Прокси отклонил логин или пароль (HTTP 407)");
  if (status === 429) throw new TargetLoadError("Google ограничил частоту запросов (HTTP 429)");
  if (status === 0 || status >= 400) {
    throw new TargetLoadError(`Google Maps вернул HTTP ${status || "без ответа"}`);
  }
}

async function parseTarget(
  context: BrowserContext,
  job: ScrapeJob,
  cb: MapsRunCallbacks,
  target: SearchTarget
): Promise<ParseTargetOutcome> {
  const page = await context.newPage();

  try {
    await gotoMaps(page, target.url);
    await waitForMapsSurface(page);
    await randomDelay(job);

    if (await isBlocked(page)) {
      log(cb, "error", "Captcha wall detected", { url: page.url(), query: target.query });
      return {
        ok: false,
        retryable: true,
        message: `Google вернул блокировку или captcha для ${target.query}`
      };
    }

    const links = await collectPlaceLinks(page, job, cb, target);
    log(cb, "info", "Discovered place links", { count: links.length, query: target.query });
    addDiscoveredPlaces(job, cb, links.length);

    const placeLinks = links.slice(0, job.settings.limitPerQuery);
    const concurrency = placeConcurrency();
    log(cb, "info", "Parsing place links", {
      count: placeLinks.length,
      concurrency,
      query: target.query
    });

    await runConcurrentPool(
      placeLinks,
      concurrency,
      async (link) => {
        await waitWhilePaused(cb);
        if (cb.shouldStop()) return;

        const result = await parsePlace(context, job, cb, target, link);
        addResult(job, cb, result);
        await randomDelay(job);
      },
      cb.shouldStop
    );
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : `Не удалось обработать ${target.query}`;
    log(cb, "error", `Target failed: ${message}`, { query: target.query });
    return {
      ok: false,
      retryable: error instanceof TargetLoadError || isRetryableNavigationError(message),
      message
    };
  } finally {
    await closePage(page);
  }
}

function placeConcurrency(): number {
  const configured = Number(process.env.GOOGLE_MAPS_PLACE_CONCURRENCY ?? DEFAULT_PLACE_CONCURRENCY);
  if (!Number.isFinite(configured)) return DEFAULT_PLACE_CONCURRENCY;
  return Math.min(MAX_PLACE_CONCURRENCY, Math.max(1, Math.floor(configured)));
}

async function collectPlaceLinks(page: Page, job: ScrapeJob, cb: MapsRunCallbacks, target: SearchTarget): Promise<string[]> {
  if (page.url().includes("/maps/place/") && await page.locator(PLACE_TITLE_SELECTOR).first().isVisible().catch(() => false)) {
    return [ensureGoogleMapsLocale(page.url(), job.settings.language, job.settings.region)];
  }

  const links = new Set<string>();
  let stableRounds = 0;

  while (links.size < job.settings.limitPerQuery && stableRounds < 5 && !cb.shouldStop()) {
    await waitWhilePaused(cb);

    const before = links.size;
    const hrefs = await withDeadline(
      page.locator(RESULT_LINK_SELECTOR).evaluateAll((items) => items.map((item) => (item as HTMLAnchorElement).href)),
      PAGE_OPERATION_TIMEOUT_MS,
      "Google Maps перестал отвечать при чтении выдачи"
    );
    for (const href of hrefs) {
      links.add(ensureGoogleMapsLocale(href, job.settings.language, job.settings.region));
    }

    if (links.size === before) stableRounds += 1;
    else stableRounds = 0;

    setStatus(job, cb, "running", `Найдено ${links.size} ссылок для: ${target.query}`);
    await scrollResults(page);
    await randomDelay(job);
  }

  if (links.size === 0) {
    throw new TargetLoadError(`Выдача Google Maps для «${target.query}» открылась без карточек организаций`);
  }

  return [...links];
}

async function parsePlace(context: BrowserContext, job: ScrapeJob, cb: MapsRunCallbacks, target: SearchTarget, url: string): Promise<PlaceResult> {
  const page = await context.newPage();
  const placeUrl = ensureGoogleMapsLocale(url, job.settings.language, job.settings.region);

  try {
    await gotoMaps(page, placeUrl);
    await page.waitForSelector("h1", { timeout: MAPS_READY_TIMEOUT_MS });
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
    await closePage(page);
  }
}

async function waitForMapsSurface(page: Page): Promise<void> {
  const deadline = Date.now() + MAPS_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isBlockedUrl(page.url())) {
      throw new TargetLoadError("Google вернул captcha или страницу блокировки");
    }
    if (page.url().startsWith("chrome-error://")) {
      throw new TargetLoadError("Chromium не смог открыть Google Maps");
    }

    const readyCount = await withDeadline(
      page.locator(MAPS_READY_SELECTOR).count(),
      PAGE_OPERATION_TIMEOUT_MS,
      "Google Maps не отвечает после загрузки"
    );
    if (readyCount > 0) return;
    if (await maybeAcceptConsent(page)) continue;
    await page.waitForTimeout(500);
  }

  if (await isBlocked(page)) {
    throw new TargetLoadError("Google вернул captcha или страницу блокировки");
  }
  const diagnostic = await pageDiagnostic(page);
  throw new TargetLoadError(`Интерфейс Google Maps не загрузился${diagnostic ? ` (${diagnostic})` : ""}`);
}

async function maybeAcceptConsent(page: Page): Promise<boolean> {
  const labels = ["Принять все", "Согласен", "I agree", "Accept all", "Accept"];
  for (const label of labels) {
    const button = page.getByRole("button", { name: label }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => undefined);
      await page.waitForTimeout(1000);
      return true;
    }
  }
  return false;
}

async function isBlocked(page: Page): Promise<boolean> {
  if (isBlockedUrl(page.url())) return true;
  const body = (await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).toLowerCase();
  return body.includes("unusual traffic")
    || body.includes("подозрительный трафик")
    || body.includes("наши системы обнаружили необычный трафик")
    || body.includes("captcha");
}

function isBlockedUrl(value: string): boolean {
  const url = value.toLowerCase();
  return url.includes("/sorry/") || url.includes("captcha");
}

async function scrollResults(page: Page): Promise<void> {
  const feed = page.locator(FEED_SELECTOR).first();
  if (await feed.isVisible().catch(() => false)) {
    await feed.evaluate(
      (node) => node.scrollTo({ top: node.scrollHeight, behavior: "instant" as ScrollBehavior }),
      { timeout: PAGE_OPERATION_TIMEOUT_MS }
    );
  } else {
    await withDeadline(
      page.mouse.wheel(0, 1800),
      PAGE_OPERATION_TIMEOUT_MS,
      "Google Maps перестал отвечать при прокрутке выдачи"
    );
  }
}

async function pageDiagnostic(page: Page): Promise<string> {
  const body = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  const compact = body.replace(/\s+/g, " ").trim().slice(0, 180);
  if (compact) return compact;
  try {
    return new URL(page.url()).hostname || page.url().slice(0, 120);
  } catch {
    return page.url().slice(0, 120);
  }
}

function isRetryableNavigationError(message: string): boolean {
  return /timeout|timed out|net::|target page.*closed|browser.*closed|navigation/i.test(message);
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0].slice(0, 300);
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new TargetLoadError(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closePage(page: Page): Promise<void> {
  await Promise.race([
    page.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 3000))
  ]);
}

async function closeBrowser(browser: Browser): Promise<void> {
  await Promise.race([
    browser.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 5000))
  ]);
}

async function closeBrowserSession(session: BrowserSession): Promise<void> {
  await closeBrowser(session.browser);
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
