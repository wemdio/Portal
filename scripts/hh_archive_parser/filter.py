"""
filter.py — фильтрует сырой CSV, оставляя только PR-вакансии.

Логика трёх корзин:
  1. ЗАГОЛОВОК содержит PR-слово  → берём сразу (без запроса к сайту)
  2. ЗАГОЛОВОК содержит мусорное слово → выкидываем сразу
  3. Всё остальное (маркетолог, SMM, бренд...) → качаем текст описания,
     ищем PR-слова в тексте → если есть, берём

Запуск:
    python filter.py                       # читает output/vacancies_raw.csv
    python filter.py --input my_file.csv   # произвольный входной файл

Результат: output/vacancies_filtered.csv
"""

import argparse
import csv
import os
import re
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

from config import (
    PR_TITLE_KEYWORDS, TRASH_TITLE_KEYWORDS, PR_DESC_KEYWORDS,
    FILTER_WORKERS, RAW_CSV, FILTERED_CSV, OUTPUT_DIR,
)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ru-RU,ru;q=0.9",
}


# ─── Classification ───────────────────────────────────────────────────────────

def classify_by_title(title: str) -> str:
    """Возвращает 'pr' | 'trash' | 'maybe'."""
    t = title.lower()
    if any(kw in t for kw in TRASH_TITLE_KEYWORDS):
        return "trash"
    if any(kw in t for kw in PR_TITLE_KEYWORDS):
        return "pr"
    return "maybe"


def fetch_description(url: str) -> str:
    """Скачивает страницу вакансии и возвращает текст описания в нижнем регистре."""
    time.sleep(0.5)
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=12) as r:
            html = r.read().decode("utf-8")
        m = re.search(
            r'data-qa="vacancy-description"[^>]*>(.*?)</div>\s*</div>',
            html, re.DOTALL,
        )
        if m:
            text = re.sub(r"<[^>]+>", " ", m.group(1))
            return re.sub(r"\s+", " ", text).lower()
    except Exception as e:
        pass
    return ""


def has_pr_in_desc(desc: str) -> bool:
    return any(kw in desc for kw in PR_DESC_KEYWORDS)


# ─── Main ─────────────────────────────────────────────────────────────────────

def run(input_csv: str):
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    with open(input_csv, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))

    pr_rows, maybe_rows, trash_rows = [], [], []
    for r in rows:
        bucket = classify_by_title(r.get("Название_вакансии", ""))
        if bucket == "pr":
            pr_rows.append(r)
        elif bucket == "maybe":
            maybe_rows.append(r)
        else:
            trash_rows.append(r)

    print(f"Входной файл:      {len(rows)} вакансий")
    print(f"✅ Явно PR:         {len(pr_rows)}")
    print(f"❓ Пограничные:     {len(maybe_rows)}  (скачиваем описания)")
    print(f"🗑  Мусор:           {len(trash_rows)}")
    print()

    # ── Обработка пограничных ─────────────────────────────────────────────────
    rescued, dropped = [], []
    done = 0

    with ThreadPoolExecutor(max_workers=FILTER_WORKERS) as pool:
        future_to_row = {
            pool.submit(fetch_description, r["Вакансия_URL"]): r
            for r in maybe_rows
        }
        for fut in as_completed(future_to_row):
            row  = future_to_row[fut]
            desc = fut.result()
            if has_pr_in_desc(desc):
                rescued.append(row)
            else:
                dropped.append(row)
            done += 1
            if done % 200 == 0 or done == len(maybe_rows):
                pct = 100 * done // len(maybe_rows)
                print(f"  [{pct:3}%] {done}/{len(maybe_rows)} — "
                      f"спасено: {len(rescued)}, отфильтровано: {len(dropped)}")

    # ── Итог ──────────────────────────────────────────────────────────────────
    final = pr_rows + rescued
    print(f"\n{'=' * 55}")
    print(f"✅ ИТОГО PR-вакансий: {len(final)}")
    print(f"   Из них спасено из пограничных: {len(rescued)}")
    print(f"   Отсеяно всего: {len(rows) - len(final)}")

    if not final:
        print("Пустой результат — файл не сохранён.")
        return

    with open(FILTERED_CSV, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=final[0].keys())
        writer.writeheader()
        writer.writerows(final)

    with_site = sum(1 for r in final if r.get("Сайт_компании"))
    print(f"   Со сайтом: {with_site}/{len(final)} ({100 * with_site // len(final)}%)")
    print(f"\n💾 Сохранено: {FILTERED_CSV}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default=RAW_CSV,
                        help="Путь к входному CSV (по умолчанию output/vacancies_raw.csv)")
    args = parser.parse_args()
    run(args.input)
