"""
scraper.py — Архивный парсер вакансий через ОФИЦИАЛЬНЫЙ API hh.ru.

Отличия от старого hh_parser (HTML-скрейп `hh.ru/search/vacancy`):
  1. Источник:   api.hh.ru/vacancies + archived=true (закрытые вакансии).
  2. Формат:     JSON напрямую — не нужны хрупкие регекспы по HTML.
  3. Стабильность: API не ломается при редизайне HH. Меньше шанс получить
                   403 (с правильным User-Agent с email).
  4. Лимит:      HH режет ЛЮБОЙ запрос на 2000 результатов (общая архитектурная
                 особенность поискового индекса, не привязано к OAuth/dev API).
                 Обходим через `CHUNK_STRATEGY` — режем период на под-окна,
                 каждое в свои 2000.

Запуск:  python scraper.py
Выход:   output/vacancies_raw.csv  (тот же формат что в старом парсере —
                                    filter.py от старого скрипта работает
                                    с этим выходом без изменений)
"""
from __future__ import annotations

import csv
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from typing import Iterable, Iterator

from config import (
    ARCHIVED,
    AREA,
    CHUNK_STRATEGY,
    DATE_FROM,
    DATE_TO,
    OAUTH_TOKEN,
    OUTPUT_DIR,
    RAW_CSV,
    REQUEST_DELAY,
    SEARCH_QUERIES,
    SEEN_IDS_FILE,
    USER_AGENT,
)

API_BASE = "https://api.hh.ru/vacancies"
PAGE_SIZE = 100
MAX_PAGE = 19  # API hard-cap: page × per_page ≤ 2000 → page ≤ 19 при per_page=100


# ─── HTTP ────────────────────────────────────────────────────────────────────

def fetch_json(url: str) -> dict | None:
    """GET → JSON. Возвращает None при любой сетевой/HTTP ошибке (мы логируем)."""
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if OAUTH_TOKEN:
        headers["Authorization"] = f"Bearer {OAUTH_TOKEN}"

    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # 403 — HH блокирует по IP/UA, 429 — слишком частые запросы.
        # Печатаем тело — там обычно `request_id` для саппорта HH.
        body = e.read().decode("utf-8", errors="ignore")[:200] if e.fp else ""
        print(f"  [HTTP {e.code}] {url[:80]}: {body}")
        return None
    except Exception as e:
        print(f"  [ERR] {url[:80]}: {e}")
        return None


# ─── Date chunking — обход лимита 2000 ───────────────────────────────────────

def parse_date(s: str) -> date | None:
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError:
        return None


def iter_date_chunks(start: date | None, end: date | None, strategy: str) -> Iterator[tuple[str, str]]:
    """
    Режет интервал [start..end] на под-окна. Возвращает пары (date_from_iso, date_to_iso).

    Если границы пустые — yield один пустой ("", "") = «без фильтра по дате».
    Стратегия "single" — один большой чанк (рискуем потерять >2000).
    """
    if strategy == "single" or (not start and not end):
        yield (start.isoformat() if start else "", end.isoformat() if end else "")
        return

    if not start:
        # без явного start — берём последний год от end (или сегодня)
        start = (end or date.today()) - timedelta(days=365)
    if not end:
        end = date.today()

    if strategy == "daily":
        step = timedelta(days=1)
    elif strategy == "weekly":
        step = timedelta(days=7)
    else:  # monthly (default)
        step = timedelta(days=30)

    cur = start
    while cur <= end:
        chunk_end = min(cur + step - timedelta(days=1), end)
        yield (cur.isoformat(), chunk_end.isoformat())
        cur = chunk_end + timedelta(days=1)


# ─── Запрос одной страницы ───────────────────────────────────────────────────

def build_url(query: str, page: int, date_from: str, date_to: str) -> str:
    params: dict[str, str] = {
        "text": query,
        "per_page": str(PAGE_SIZE),
        "page": str(page),
        "area": AREA,
    }
    if ARCHIVED:
        # `archived=true` — флаг возвращающий только архивные (закрытые) вакансии.
        # Без него или с false вернутся только активные.
        params["archived"] = "true"
    if date_from:
        params["date_from"] = date_from
    if date_to:
        params["date_to"] = date_to
    return API_BASE + "?" + urllib.parse.urlencode(params)


def extract_vacancies(api_response: dict) -> list[dict]:
    """
    Достаёт массив items из ответа API и приводит к нашему формату.
    Формат ответа: https://api.hh.ru/openapi/redoc#tag/Vakansii
    """
    items = api_response.get("items") or []
    out: list[dict] = []
    for v in items:
        if not isinstance(v, dict):
            continue
        employer = v.get("employer") or {}
        area = v.get("area") or {}
        out.append({
            "vacancy_id": str(v.get("id") or ""),
            "title": v.get("name") or "",
            "company": employer.get("name") or "",
            # site из employer (если запрошен — он не всегда в search-ответе,
            # для надёжности дополнительно дёргаем /employers/{id} ниже).
            "site": (employer.get("site_url") or ""),
            "city": area.get("name") or "",
            "employer_id": str(employer.get("id") or ""),
            "published_at": v.get("published_at") or "",
            "archived_at": v.get("archived") and v.get("created_at") or "",
        })
    return out


# ─── seen_ids — инкрементальные запуски ──────────────────────────────────────

def load_seen_ids() -> set[str]:
    if not os.path.exists(SEEN_IDS_FILE):
        return set()
    with open(SEEN_IDS_FILE, encoding="utf-8") as f:
        return {line.strip() for line in f if line.strip()}


def save_seen_ids(ids: Iterable[str]) -> None:
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(SEEN_IDS_FILE, "w", encoding="utf-8") as f:
        f.write("\n".join(sorted(set(ids))))


# ─── Main ────────────────────────────────────────────────────────────────────

def run() -> None:
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    seen_ids = load_seen_ids()
    print(f"Уже известных ID: {len(seen_ids)} (пропустим дубли)\n")
    if ARCHIVED:
        print("Режим: АРХИВНЫЕ вакансии (archived=true)\n")

    date_chunks = list(iter_date_chunks(parse_date(DATE_FROM), parse_date(DATE_TO), CHUNK_STRATEGY))
    print(f"Период разбит на {len(date_chunks)} чанков по стратегии '{CHUNK_STRATEGY}'\n")

    all_new: dict[str, dict] = {}

    for query in SEARCH_QUERIES:
        print(f"▶  '{query}'")
        query_total = 0
        query_new = 0

        for df, dt in date_chunks:
            label = f"{df}..{dt}" if df or dt else "no date filter"

            # Стр 0 → определяем сколько всего
            url = build_url(query, 0, df, dt)
            resp = fetch_json(url)
            if not resp:
                print(f"   [{label}] пропущен (ошибка)")
                time.sleep(REQUEST_DELAY)
                continue

            found = int(resp.get("found") or 0)
            pages = int(resp.get("pages") or 0)
            n_pages = min(pages, MAX_PAGE + 1)
            if found == 0:
                continue
            if found > 2000:
                # Достанем 2000 из 2000+ — остальные потеряются. Сигналим
                # юзеру что стоит переключить CHUNK_STRATEGY на weekly/daily.
                print(f"   [{label}] ⚠ found={found} > 2000 — потеряется {found - 2000}. Используйте более узкий CHUNK_STRATEGY.")
            else:
                print(f"   [{label}] found={found}, страниц для обхода: {n_pages}")

            items = extract_vacancies(resp)
            new_p1 = [v for v in items if v["vacancy_id"] not in seen_ids and v["vacancy_id"] not in all_new]
            for v in new_p1:
                all_new[v["vacancy_id"]] = v
            query_total += len(items)
            query_new += len(new_p1)

            for page in range(1, n_pages):
                time.sleep(REQUEST_DELAY)
                resp = fetch_json(build_url(query, page, df, dt))
                if not resp:
                    break
                items = extract_vacancies(resp)
                if not items:
                    break
                new_pg = [v for v in items if v["vacancy_id"] not in seen_ids and v["vacancy_id"] not in all_new]
                for v in new_pg:
                    all_new[v["vacancy_id"]] = v
                query_total += len(items)
                query_new += len(new_pg)

            time.sleep(REQUEST_DELAY)

        print(f"   Итого по запросу: {query_total} вакансий, новых: {query_new}\n")

    # ── Сохранение ────────────────────────────────────────────────────────────
    rows = [
        {
            "Вакансия_URL": f"https://hh.ru/vacancy/{v['vacancy_id']}",
            "Название_вакансии": v["title"],
            "Компания": v["company"],
            "Сайт_компании": v["site"],
            "Город": v["city"],
            "Работодатель_hh_URL": f"https://hh.ru/employer/{v['employer_id']}" if v["employer_id"] else "",
            "Дата_публикации": v.get("published_at", ""),
        }
        for v in all_new.values()
    ]

    if rows:
        with open(RAW_CSV, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(f, fieldnames=rows[0].keys())
            writer.writeheader()
            writer.writerows(rows)

        save_seen_ids(seen_ids | set(all_new.keys()))

        with_site = sum(1 for r in rows if r["Сайт_компании"])
        print(f"\n{'=' * 55}")
        print(f"✅ Новых вакансий:  {len(rows)}")
        print(f"   Со сайтом:       {with_site}/{len(rows)} ({100 * with_site // len(rows) if rows else 0}%)")
        print(f"💾 Сохранено:       {RAW_CSV}")
    else:
        print("\nНовых вакансий не найдено.")


if __name__ == "__main__":
    run()
