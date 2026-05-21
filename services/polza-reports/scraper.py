"""Coldy web scraper.

Copied from polza_bot/scraper.py with two changes:
  1. ColdyCredentials / Campaign / CampaignAnalytics / LetterStat now live in
     models.py (no more dependency on the Telegram bot's app_settings module).
  2. scrape_all() accepts an optional async ``on_progress`` callback so the
     FastAPI layer can stream SSE progress events to the Portal.

All Coldy-specific selectors and fallbacks are preserved verbatim — these took
work to get right and are the reason we keep the original Python implementation
instead of rewriting in TypeScript.
"""
from __future__ import annotations

import re
import logging
from typing import Awaitable, Callable, Optional

from playwright.async_api import async_playwright, Page, BrowserContext, TimeoutError as PlaywrightTimeoutError

from models import Campaign, CampaignAnalytics, ColdyCredentials, LetterStat

logger = logging.getLogger(__name__)

ProgressCallback = Callable[[dict], Awaitable[None]]


def _is_auth_url(url: str) -> bool:
    return "/login" in url or "/sign-in" in url


def _parse_int(text: str) -> int:
    text = text.strip().replace("\xa0", "").replace(" ", "")
    try:
        return int(re.sub(r"[^\d]", "", text) or "0")
    except ValueError:
        return 0


def _parse_pct(text: str) -> float:
    m = re.search(r"([\d.]+)%", text)
    return float(m.group(1)) if m else 0.0


def _parse_fraction(text: str) -> tuple[int, int]:
    """Parse 'X/Y' into (X, Y)."""
    m = re.match(r"(\d+)/(\d+)", text.strip())
    if m:
        return int(m.group(1)), int(m.group(2))
    n = _parse_int(text)
    return n, n


def _absolute_url(base_url: str, href: str) -> str:
    if not href:
        return ""
    if href.startswith("http"):
        return href
    if href.startswith("/"):
        return base_url + href
    return f"{base_url}/{href}"


async def _emit(on_progress: Optional[ProgressCallback], event: dict) -> None:
    if on_progress is None:
        return
    try:
        await on_progress(event)
    except Exception:  # noqa: BLE001 — never let progress sinks break the scrape
        logger.exception("Progress callback raised, swallowing")


async def _login(page: Page, credentials: ColdyCredentials) -> None:
    if not credentials.email or not credentials.password:
        raise RuntimeError("Логин и пароль Coldy не заданы")

    logger.info("Logging in to Coldy...")
    await page.goto(f"{credentials.url}/sign-in", wait_until="networkidle")

    # Try common input selectors for email/password
    await page.locator('input[type="email"], input[name="email"]').first.fill(credentials.email)
    password_input = page.locator('input[type="password"], input[name="password"]').first
    await password_input.fill(credentials.password)

    submit_button = page.locator(
        'button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), '
        'button:has-text("Войти"), button:has-text("Продолжить")'
    ).first

    try:
        await submit_button.click(timeout=5_000)
    except PlaywrightTimeoutError:
        logger.info("Submit button was not found, trying Enter from password input")
        await password_input.press("Enter")

    try:
        await page.wait_for_url(lambda url: not _is_auth_url(url), timeout=15_000)
    except PlaywrightTimeoutError:
        raise RuntimeError("Не удалось войти в Coldy. Проверьте логин и пароль.") from None

    logger.info("Login successful, current URL: %s", page.url)


async def _get_campaigns_list(page: Page, base_url: str) -> list[Campaign]:
    logger.info("Navigating to campaigns list...")
    await page.goto(f"{base_url}/campaigns", wait_until="networkidle")

    if "/campaigns" not in page.url:
        raise RuntimeError(f"Не удалось открыть список кампаний. Текущая страница: {page.url}")

    await page.wait_for_selector("table, [class*='table'], [class*='campaign']", timeout=15_000)

    campaigns: list[Campaign] = []

    rows = await page.locator("tbody tr").all()
    if not rows:
        # Fallback: try any row-like structure
        rows = await page.locator("[class*='row']:has([class*='name']), [class*='item']").all()

    for row_index, row in enumerate(rows):
        cells = await row.locator("td").all()
        if len(cells) < 5:
            continue

        name_cell = cells[0]
        name_locator = name_cell.locator("a, [class*='name'], strong, b")
        name = ""
        if await name_locator.count():
            name = (await name_locator.first.inner_text()).strip()
        if not name:
            name = (await name_cell.inner_text()).strip().split("\n")[0]

        # Status badges inside name cell
        badges = await name_cell.locator("[class*='badge'], [class*='status'], [class*='tag']").all()
        status = " | ".join([(await b.inner_text()).strip() for b in badges]) or "—"

        created = (await cells[1].inner_text()).strip()
        sent = _parse_int(await cells[2].inner_text())

        connected_text = (await cells[3].inner_text()).strip()
        reached, total = _parse_fraction(connected_text)

        opened_text = (await cells[4].inner_text()).strip()
        opened = _parse_int(opened_text.split("(")[0])
        opened_pct = _parse_pct(opened_text)

        replied_text = (await cells[5].inner_text()).strip() if len(cells) > 5 else "0"
        replied = _parse_int(replied_text.split("(")[0])
        replied_pct = _parse_pct(replied_text)

        # Grab link to the campaign detail page. In Coldy it may be in any cell of the row.
        campaign_links = row.locator("a[href*='/campaigns/'], a[href*='campaign']")
        if not await campaign_links.count():
            campaign_links = row.locator("a")

        href = ""
        for link in await campaign_links.all():
            candidate = await link.get_attribute("href") or ""
            normalized = candidate.rstrip("/")
            if candidate and not normalized.endswith("/campaigns") and not candidate.startswith("#"):
                href = candidate
                break

        href = _absolute_url(base_url, href)

        campaigns.append(Campaign(
            name=name,
            status=status,
            created=created,
            sent=sent,
            connected_reached=reached,
            connected_total=total,
            opened=opened,
            opened_pct=opened_pct,
            replied=replied,
            replied_pct=replied_pct,
            url=href,
            row_index=row_index,
        ))

    await _resolve_missing_campaign_urls(page, base_url, campaigns)

    logger.info("Found %d campaigns", len(campaigns))
    return campaigns


async def _resolve_missing_campaign_urls(page: Page, base_url: str, campaigns: list[Campaign]) -> None:
    missing = [campaign for campaign in campaigns if not campaign.url]
    if not missing:
        return

    logger.info("Resolving detail URLs for %d campaigns by clicking rows", len(missing))

    for campaign in missing:
        try:
            await page.goto(f"{base_url}/campaigns", wait_until="networkidle")
            await page.wait_for_selector("tbody tr", timeout=15_000)

            row = page.locator("tbody tr").nth(campaign.row_index)
            name_target = row.get_by_text(campaign.name, exact=False).first
            click_target = row.locator("a[href*='/campaigns/'], a[href*='campaign']").first

            if campaign.name and await name_target.count():
                await name_target.click(timeout=5_000)
            elif await click_target.count():
                await click_target.click(timeout=5_000)
            else:
                await row.click(timeout=5_000)

            await page.wait_for_url(lambda url: "/campaigns" in url and url.rstrip("/") != f"{base_url}/campaigns", timeout=10_000)
            campaign.url = page.url
            logger.info("Resolved campaign URL for %s: %s", campaign.name, campaign.url)
        except Exception as e:
            logger.warning("Failed to resolve campaign URL for %s: %s", campaign.name, e)


async def _get_analytics(page: Page, campaign: Campaign) -> Optional[CampaignAnalytics]:
    if not campaign.url:
        return None

    logger.info("Fetching analytics for: %s", campaign.name)

    # Navigate to campaign page
    await page.goto(campaign.url, wait_until="networkidle")

    # Open "Аналитика". Different Coldy screens expose it as a tab, link, or plain button.
    analytics_tab = page.get_by_role("tab", name=re.compile("аналитика", re.IGNORECASE))
    analytics_link = page.get_by_role("link", name=re.compile("аналитика", re.IGNORECASE))
    analytics_button = page.get_by_role("button", name=re.compile("аналитика", re.IGNORECASE))
    analytics_text = page.get_by_text(re.compile(r"^\s*аналитика\s*$", re.IGNORECASE))

    if await analytics_tab.count():
        await analytics_tab.first.click()
        await page.wait_for_timeout(1500)
    elif await analytics_link.count():
        await analytics_link.first.click()
        await page.wait_for_load_state("networkidle")
    elif await analytics_button.count():
        await analytics_button.first.click()
        await page.wait_for_timeout(1500)
    elif await analytics_text.count():
        await analytics_text.first.click()
        await page.wait_for_timeout(1500)
    else:
        analytics_url = campaign.url.rstrip("/") + "/analytics"
        await page.goto(analytics_url, wait_until="networkidle")

    # --- Summary cards ---
    async def card_values(label_pattern: str) -> tuple[int, float]:
        card = page.locator(
            f"[class*='card'], [class*='stat'], [class*='metric']"
        ).filter(has_text=re.compile(label_pattern, re.IGNORECASE)).first

        text = await card.inner_text() if await card.count() else ""
        nums = re.findall(r"[\d.]+", text)
        val = int(nums[0]) if nums else 0
        pct = float(nums[1]) if len(nums) > 1 else 0.0
        return val, pct

    conn_val, _ = await card_values("связались")
    open_val, open_pct = await card_values("открыли")
    rep_val, rep_pct = await card_values("ответили")
    int_val, int_pct = await card_values("заинтересован")

    # --- Letter stats table ---
    letters: list[LetterStat] = []

    # Open "Статистика писем" inside analytics before reading the table.
    letters_tab = page.get_by_role("tab", name=re.compile("статистика писем", re.IGNORECASE))
    letters_button = page.get_by_role("button", name=re.compile("статистика писем", re.IGNORECASE))
    letters_text = page.get_by_text(re.compile("статистика писем", re.IGNORECASE))

    if await letters_tab.count():
        await letters_tab.first.click()
        await page.wait_for_timeout(1200)
    elif await letters_button.count():
        await letters_button.first.click()
        await page.wait_for_timeout(1200)
    elif await letters_text.count():
        await letters_text.first.click()
        await page.wait_for_timeout(1200)
    else:
        logger.warning("Letters statistics tab was not found for %s", campaign.name)

    try:
        await page.wait_for_selector("tbody tr", timeout=10_000)
    except PlaywrightTimeoutError:
        logger.warning("Letters statistics table was not found for %s", campaign.name)
        return CampaignAnalytics(
            connected=conn_val,
            opened=open_val,
            opened_pct=open_pct,
            replied=rep_val,
            replied_pct=rep_pct,
            interested=int_val,
            interested_pct=int_pct,
            letters=letters,
        )

    letter_rows = await page.locator("tbody tr").all()
    for lr in letter_rows:
        lcells = await lr.locator("td").all()
        if len(lcells) < 3:
            continue
        letter_name = (await lcells[0].inner_text()).strip()
        l_sent = _parse_int(await lcells[1].inner_text())
        l_open_text = (await lcells[2].inner_text()).strip()
        l_rep_text = (await lcells[3].inner_text()).strip() if len(lcells) > 3 else "0"

        letters.append(LetterStat(
            name=letter_name,
            sent=l_sent,
            opened=_parse_int(l_open_text.split("(")[0]),
            opened_pct=_parse_pct(l_open_text),
            replied=_parse_int(l_rep_text.split("(")[0]),
            replied_pct=_parse_pct(l_rep_text),
        ))

    return CampaignAnalytics(
        connected=conn_val,
        opened=open_val,
        opened_pct=open_pct,
        replied=rep_val,
        replied_pct=rep_pct,
        interested=int_val,
        interested_pct=int_pct,
        letters=letters,
    )


async def scrape_all(
    detailed: bool = True,
    credentials: ColdyCredentials | None = None,
    on_progress: Optional[ProgressCallback] = None,
) -> list[Campaign]:
    """Scrape campaigns from Coldy.

    Args:
        detailed: if True, also fetch per-campaign analytics (slower).
        credentials: Coldy login. Must be complete; we do not read env or DB here.
        on_progress: optional async callback called with phase events:
          {"phase": "login"}
          {"phase": "campaigns_list", "total": N}
          {"phase": "analytics", "current": i, "total": N, "campaign_name": "..."}
    """
    if credentials is None or not credentials.is_complete:
        raise RuntimeError("Логин и пароль Coldy не заданы")

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context: BrowserContext = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        )
        page = await context.new_page()

        try:
            await _emit(on_progress, {"phase": "login"})
            await _login(page, credentials)

            await _emit(on_progress, {"phase": "campaigns_list"})
            campaigns = await _get_campaigns_list(page, credentials.url)
            await _emit(on_progress, {"phase": "campaigns_list", "total": len(campaigns)})

            if detailed:
                total = len(campaigns)
                for index, campaign in enumerate(campaigns, start=1):
                    await _emit(on_progress, {
                        "phase": "analytics",
                        "current": index,
                        "total": total,
                        "campaign_name": campaign.name,
                    })
                    try:
                        campaign.analytics = await _get_analytics(page, campaign)
                    except Exception as e:
                        logger.warning("Failed to get analytics for %s: %s", campaign.name, e)

        finally:
            await browser.close()

    return campaigns
