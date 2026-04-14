"""
Каскадный поиск email ЛПР по ИНН юрлиц.

Источники (в порядке приоритета):
  1. DaData — бесплатно 10 000/день (ФИО руководителя, должность, адрес, название)
  2. Serper.dev — Google Search API (email, телефоны, сайт из поисковой выдачи)
  3. Hunter.io — 50 бесплатных поисков/мес (email по домену сайта)

Использование:
    python find_emails_by_inn.py companies.csv
    python find_emails_by_inn.py companies.csv --output results.csv --delay 1.5
    python find_emails_by_inn.py companies.csv --inn-column inn --dry-run
    python find_emails_by_inn.py companies.csv --inn-column inn --limit 5
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

import requests

# ─── API-ключи ─────────────────────────────────────────────────────────
DADATA_TOKEN = os.getenv("DADATA_TOKEN", "")
SERPER_API_KEY = os.getenv("SERPER_API_KEY", "")
HUNTER_API_KEY = os.getenv("HUNTER_API_KEY", "")

EMAIL_RE = re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+")
PHONE_RU_RE = re.compile(r"\+?[78][\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}")

FREEMAIL_DOMAINS = frozenset({
    "mail.ru", "yandex.ru", "gmail.com", "bk.ru", "inbox.ru",
    "list.ru", "rambler.ru", "ya.ru", "outlook.com", "hotmail.com",
    "internet.ru", "icloud.com", "yahoo.com", "protonmail.com",
})

JUNK_EMAIL_DOMAINS = frozenset({
    "fss.ru", "ro1.fss.ru", "ro2.fss.ru", "nalog.ru",
    "pfr.gov.ru", "sfr.gov.ru", "gosuslugi.ru",
    "rbcmail.ru", "example.com", "test.com",
})

JUNK_SITE_DOMAINS = frozenset({
    "rusprofile.ru", "list-org.com", "sbis.ru", "checko.ru",
    "google.com", "yandex.ru", "wikipedia.org", "egrul.org",
    "nalog.ru", "spark-interfax.ru", "zachestnyibiznes.ru",
    "e-disclosure.ru", "audit-it.ru", "companium.ru",
    "fabricators.ru", "wiki-prom.ru", "kartoteka.ru",
    "vbankcenter.ru", "find-org.com", "bo.nalog.ru",
    "reestr-msp.ru", "casebook.ru", "kad.arbitr.ru",
    "fedresurs.ru", "bankrot.fedresurs.ru", "synapsenet.ru",
    "k-agent.ru", "orgpage.ru", "1cont.ru", "gks.ru",
    "buhonline.ru", "klerk.ru", "trudvsem.ru", "tadviser.ru",
    "pro.fira.ru", "fira.ru", "inni.info", "sro.ssrb.info",
    "e-disclosure.azipi.ru", "azipi.ru", "rbc.ru", "vc.ru",
    "hh.ru", "avito.ru", "2gis.ru", "yell.ru", "zoon.ru",
    "flamp.ru", "cataloxy.ru", "spr.ru", "a-cont.ru",
    "proverka-kontragenta.ru",
})


@dataclass
class CompanyContact:
    inn: str
    company_name: str = ""
    director: str = ""
    director_title: str = ""
    emails: list[str] = field(default_factory=list)
    phones: list[str] = field(default_factory=list)
    website: str = ""
    address: str = ""
    sources: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        normalized = item.strip().rstrip(".").lower()
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(item.strip().rstrip("."))
    return result


def _extract_domain(url: str) -> str:
    if not url:
        return ""
    url = url.strip()
    if not url.startswith(("http://", "https://")):
        url = "http://" + url
    try:
        parsed = urlparse(url)
        domain = parsed.hostname or ""
        if domain.startswith("www."):
            domain = domain[4:]
        return domain
    except Exception:
        return ""


def _clean_email(email: str) -> str:
    """Убираем точку на конце и мусорные суффиксы, фильтруем госорганы."""
    email = email.strip().rstrip(".").lower()
    if email.endswith((".png", ".jpg", ".gif", ".svg", ".css", ".js")):
        return ""
    if "@" not in email:
        return ""
    domain = email.split("@")[-1]
    if domain in JUNK_EMAIL_DOMAINS:
        return ""
    if any(domain.endswith(f".{junk}") for junk in JUNK_EMAIL_DOMAINS):
        return ""
    return email


# ═══════════════════════════════════════════════════════════════════════
# Источник 1: DaData (бесплатно, 10 000/день)
# Даёт: название, ФИО руководителя, должность, адрес, ОГРН
# НЕ даёт на бесплатном тарифе: email, телефон
# ═══════════════════════════════════════════════════════════════════════

def fetch_dadata(inn: str, contact: CompanyContact) -> None:
    if not DADATA_TOKEN:
        contact.errors.append("DaData: токен не задан")
        return

    try:
        resp = requests.post(
            "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party",
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Authorization": f"Token {DADATA_TOKEN}",
            },
            json={"query": inn, "type": "LEGAL"},
            timeout=15,
        )
        resp.raise_for_status()
    except requests.RequestException as exc:
        contact.errors.append(f"DaData: {exc}")
        return

    body = resp.json()
    suggestions = body.get("suggestions", [])
    if not suggestions:
        contact.errors.append("DaData: not_found")
        return

    data = suggestions[0].get("data", {})

    if not contact.company_name:
        name_data = data.get("name", {})
        contact.company_name = (
            name_data.get("short_with_opf")
            or name_data.get("full_with_opf", "")
        )

    mgmt = data.get("management") or {}
    if mgmt:
        contact.director = mgmt.get("name", "")
        contact.director_title = mgmt.get("post", "")

    address_data = data.get("address") or {}
    contact.address = (
        address_data.get("unrestricted_value", "")
        or address_data.get("value", "")
    )

    for phone_rec in data.get("phones") or []:
        val = phone_rec.get("value") or phone_rec.get("data", {}).get("source", "")
        if val:
            contact.phones.append(val)

    for email_rec in data.get("emails") or []:
        val = email_rec.get("value") or email_rec.get("data", {}).get("source", "")
        if val:
            contact.emails.append(val.lower())

    contact.sources.append("DaData")


# ═══════════════════════════════════════════════════════════════════════
# Источник 2: Serper.dev (Google Search API)
# Ищет email через Google по названию компании + ИНН
# ═══════════════════════════════════════════════════════════════════════

def fetch_serper(company_name: str, inn: str, contact: CompanyContact) -> None:
    if not SERPER_API_KEY:
        contact.errors.append("Serper: ключ не задан")
        return

    search_name = company_name or f"ИНН {inn}"
    query = f"{search_name} ИНН {inn} email контакты"

    try:
        resp = requests.post(
            "https://google.serper.dev/search",
            headers={
                "X-API-KEY": SERPER_API_KEY,
                "Content-Type": "application/json",
            },
            json={"q": query, "gl": "ru", "hl": "ru", "num": 10},
            timeout=15,
        )
        resp.raise_for_status()
    except requests.RequestException as exc:
        contact.errors.append(f"Serper: {exc}")
        return

    data = resp.json()

    all_text = ""

    for result in data.get("organic", []):
        snippet = result.get("snippet", "")
        title = result.get("title", "")
        all_text += f" {snippet} {title}"

        link = result.get("link", "")
        domain = _extract_domain(link)
        if domain and not contact.website:
            if domain not in JUNK_SITE_DOMAINS and not any(
                domain.endswith(f".{j}") or j in domain
                for j in JUNK_SITE_DOMAINS
            ):
                contact.website = domain

    kg = data.get("knowledgeGraph", {})
    for val in kg.values():
        if isinstance(val, str):
            all_text += f" {val}"

    for email in EMAIL_RE.findall(all_text):
        cleaned = _clean_email(email)
        if cleaned:
            contact.emails.append(cleaned)

    for phone in PHONE_RU_RE.findall(all_text):
        contact.phones.append(phone.strip())

    if contact.emails or contact.phones:
        contact.sources.append("Google/Serper")


# ═══════════════════════════════════════════════════════════════════════
# Источник 3: Hunter.io (50 бесплатных/мес)
# Поиск email по домену сайта компании
# ═══════════════════════════════════════════════════════════════════════

def fetch_hunter(domain: str, contact: CompanyContact) -> None:
    if not HUNTER_API_KEY or not domain:
        return

    try:
        resp = requests.get(
            "https://api.hunter.io/v2/domain-search",
            params={"domain": domain, "api_key": HUNTER_API_KEY, "limit": 10},
            timeout=15,
        )
        if resp.status_code != 200:
            return
    except requests.RequestException:
        return

    body = resp.json()
    for email_rec in body.get("data", {}).get("emails", []):
        val = email_rec.get("value", "")
        if val:
            contact.emails.append(val.lower())

    if body.get("data", {}).get("emails"):
        contact.sources.append("Hunter.io")


# ═══════════════════════════════════════════════════════════════════════
# Основная логика
# ═══════════════════════════════════════════════════════════════════════

def process_inn(inn: str, company_hint: str = "") -> CompanyContact:
    contact = CompanyContact(inn=inn)
    if company_hint:
        contact.company_name = company_hint

    # Шаг 1: DaData → ФИО руководителя, адрес, название
    fetch_dadata(inn, contact)
    time.sleep(0.3)

    # Шаг 2: Serper (Google) → email, телефоны, сайт
    fetch_serper(contact.company_name or company_hint, inn, contact)
    time.sleep(0.3)

    # Шаг 3: Hunter.io → дополнительные email по домену
    if contact.website:
        domain = _extract_domain(contact.website)
        if domain and domain not in FREEMAIL_DOMAINS:
            fetch_hunter(domain, contact)

    contact.emails = _dedupe(contact.emails)
    contact.phones = _dedupe(contact.phones)
    return contact


def read_inns(csv_path: Path, inn_column: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    with open(csv_path, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            raise SystemExit(f"Пустой CSV: {csv_path}")

        available = list(reader.fieldnames)
        if inn_column not in available:
            col_lower = {c.lower().strip(): c for c in available}
            match = col_lower.get(inn_column.lower().strip())
            if match:
                inn_column = match
            else:
                raise SystemExit(
                    f"Колонка '{inn_column}' не найдена. Доступные: {available}"
                )

        company_col = None
        for candidate in ("company", "компания", "наименование", "company_note", "name"):
            for col in available:
                if col.lower().strip() == candidate:
                    company_col = col
                    break
            if company_col:
                break

        for row in reader:
            raw = row.get(inn_column, "").strip()
            cleaned = re.sub(r"\D", "", raw)
            if cleaned:
                rows.append({
                    "inn": cleaned,
                    "company": row.get(company_col, "") if company_col else "",
                })

    return rows


def write_results(contacts: list[CompanyContact], output_path: Path) -> None:
    with open(output_path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "ИНН", "Компания", "Руководитель", "Должность",
            "Email", "Телефоны", "Сайт", "Адрес",
            "Источники", "Ошибки",
        ])
        for c in contacts:
            writer.writerow([
                c.inn,
                c.company_name,
                c.director,
                c.director_title,
                "; ".join(c.emails),
                "; ".join(c.phones),
                c.website,
                c.address,
                ", ".join(c.sources),
                "; ".join(c.errors) if c.errors else "",
            ])


def main() -> None:
    parser = argparse.ArgumentParser(description="Каскадный поиск email ЛПР по ИНН")
    parser.add_argument("input", type=Path, help="CSV с ИНН")
    parser.add_argument("--output", "-o", type=Path, default=None)
    parser.add_argument("--inn-column", default="inn")
    parser.add_argument("--delay", type=float, default=1.5, help="Задержка между компаниями (сек)")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    if not args.input.exists():
        raise SystemExit(f"Файл не найден: {args.input}")

    output_path = args.output or args.input.with_name(args.input.stem + "_results.csv")
    rows = read_inns(args.input, args.inn_column)

    if not rows:
        raise SystemExit("Не найдено ни одного ИНН")

    if args.limit > 0:
        rows = rows[: args.limit]

    print(f"Компаний: {len(rows)}")
    print(f"Выходной файл: {output_path}")
    print(f"DaData:   {'OK' if DADATA_TOKEN else 'НЕТ (DADATA_TOKEN)'}")
    print(f"Serper:   {'OK' if SERPER_API_KEY else 'НЕТ (SERPER_API_KEY)'}")
    print(f"Hunter:   {'OK' if HUNTER_API_KEY else '—'}")
    print()

    if args.dry_run:
        for i, row in enumerate(rows, 1):
            print(f"  {i}. {row['inn']}  {row['company']}")
        print("\n--dry-run: запросы не отправлены")
        return

    contacts: list[CompanyContact] = []
    total = len(rows)

    for i, row in enumerate(rows, 1):
        inn = row["inn"]
        label = row["company"][:40] if row["company"] else inn
        print(f"[{i}/{total}] {label} ... ", end="", flush=True)

        contact = process_inn(inn, company_hint=row["company"])
        contacts.append(contact)

        n_emails = len(contact.emails)
        email_preview = ", ".join(contact.emails[:3]) if contact.emails else "—"
        src = ", ".join(contact.sources)
        print(f"{n_emails} email [{src}]: {email_preview}")

        if i < total:
            time.sleep(args.delay)

    write_results(contacts, output_path)

    found_email = sum(1 for c in contacts if c.emails)
    found_phone = sum(1 for c in contacts if c.phones)
    found_director = sum(1 for c in contacts if c.director)
    total_emails = sum(len(c.emails) for c in contacts)

    print(f"\n{'='*60}")
    print(f"  Обработано:       {total}")
    print(f"  С email:          {found_email} ({found_email*100//max(total,1)}%)")
    print(f"  С телефонами:     {found_phone} ({found_phone*100//max(total,1)}%)")
    print(f"  С ФИО рук-ля:     {found_director} ({found_director*100//max(total,1)}%)")
    print(f"  Всего email:      {total_emails}")
    print(f"  Результат:        {output_path}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
