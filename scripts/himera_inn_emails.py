"""
Поиск email ЛПР по ИНН юрлиц через Himera Search API v2.

Использование:
    python himera_inn_emails.py input.csv
    python himera_inn_emails.py input.csv --output results.csv --delay 2.0
    python himera_inn_emails.py input.csv --inn-column ИНН --dry-run

CSV на входе должен содержать колонку с ИНН (по умолчанию "inn").
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import requests

API_BASE = "https://api.himera-search.info/2.0"
API_KEY = "3b2fe67d76dae8a701f64b602910faab"

EMAIL_RE = re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+")


@dataclass
class ContactInfo:
    inn: str
    company_name: str = ""
    emails: list[str] = field(default_factory=list)
    phones: list[str] = field(default_factory=list)
    names: list[str] = field(default_factory=list)
    raw_sources: list[str] = field(default_factory=list)
    report_url: str = ""
    error: str = ""


def search_by_inn(inn: str) -> ContactInfo:
    """Запрос к Himera API v2 по ИНН юрлица."""
    contact = ContactInfo(inn=inn)

    try:
        resp = requests.post(
            f"{API_BASE}/inn",
            data={"key": API_KEY, "inn": inn},
            timeout=60,
        )
        resp.raise_for_status()
    except requests.RequestException as exc:
        contact.error = f"HTTP error: {exc}"
        return contact

    try:
        body = resp.json()
    except json.JSONDecodeError:
        contact.error = f"Invalid JSON: {resp.text[:200]}"
        return contact

    if "error" in body:
        contact.error = body["error"]
        return contact

    if body.get("status") == "not_found":
        contact.error = "not_found"
        return contact

    contact.report_url = body.get("url", "")
    records: list[dict[str, Any]] = body.get("data", [])

    for rec in records:
        _extract_fields(rec, contact)

    contact.emails = _dedupe(contact.emails)
    contact.phones = _dedupe(contact.phones)
    contact.names = _dedupe(contact.names)
    return contact


def _extract_fields(rec: dict[str, Any], contact: ContactInfo) -> None:
    """Извлекает email, телефоны, ФИО и название компании из записи отчёта."""
    source = rec.get("ИСТОЧНИК", "")
    if source:
        contact.raw_sources.append(source)

    for key, val in rec.items():
        if not isinstance(val, str) or not val.strip():
            continue
        val = val.strip()
        key_lower = key.lower()

        if "email" in key_lower or "почт" in key_lower or "e-mail" in key_lower:
            for email in EMAIL_RE.findall(val):
                contact.emails.append(email.lower())

        if "телефон" in key_lower or "phone" in key_lower:
            contact.phones.append(val)

        if key_lower in ("имя", "фио", "name", "руководитель", "директор", "генеральный директор"):
            contact.names.append(val)

        if key_lower in ("наименование", "название", "компания", "организация", "юр. лицо"):
            if not contact.company_name:
                contact.company_name = val

    for val in rec.values():
        if isinstance(val, str):
            for email in EMAIL_RE.findall(val):
                contact.emails.append(email.lower())


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result


def read_inns(csv_path: Path, inn_column: str) -> list[str]:
    """Читает список ИНН из CSV-файла."""
    inns: list[str] = []
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

        for row in reader:
            raw = row.get(inn_column, "").strip()
            cleaned = re.sub(r"\D", "", raw)
            if cleaned:
                inns.append(cleaned)

    return inns


def write_results(contacts: list[ContactInfo], output_path: Path) -> None:
    """Записывает результаты в CSV."""
    with open(output_path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "ИНН", "Компания", "Email", "Телефоны", "ФИО/ЛПР",
            "Ссылка на отчёт", "Ошибка",
        ])
        for c in contacts:
            writer.writerow([
                c.inn,
                c.company_name,
                "; ".join(c.emails),
                "; ".join(c.phones),
                "; ".join(c.names),
                c.report_url,
                c.error,
            ])


def main() -> None:
    parser = argparse.ArgumentParser(description="Поиск email ЛПР по ИНН через Himera API")
    parser.add_argument("input", type=Path, help="CSV с ИНН")
    parser.add_argument("--output", "-o", type=Path, default=None, help="Выходной CSV")
    parser.add_argument("--inn-column", default="inn", help="Название колонки с ИНН (по умолчанию: inn)")
    parser.add_argument("--delay", type=float, default=1.5, help="Задержка между запросами в секундах")
    parser.add_argument("--dry-run", action="store_true", help="Показать ИНН без реальных запросов")
    parser.add_argument("--limit", type=int, default=0, help="Максимальное кол-во ИНН для обработки (0 = все)")
    args = parser.parse_args()

    if not args.input.exists():
        raise SystemExit(f"Файл не найден: {args.input}")

    output_path = args.output or args.input.with_name(
        args.input.stem + "_emails.csv"
    )

    inns = read_inns(args.input, args.inn_column)
    if not inns:
        raise SystemExit("Не найдено ни одного ИНН в файле")

    if args.limit > 0:
        inns = inns[: args.limit]

    print(f"Найдено ИНН: {len(inns)}")
    print(f"Выходной файл: {output_path}")

    if args.dry_run:
        for i, inn in enumerate(inns, 1):
            print(f"  {i}. {inn}")
        print("\n--dry-run: запросы не выполнены")
        return

    contacts: list[ContactInfo] = []
    total = len(inns)

    for i, inn in enumerate(inns, 1):
        print(f"[{i}/{total}] ИНН {inn} ... ", end="", flush=True)
        contact = search_by_inn(inn)
        contacts.append(contact)

        if contact.error:
            print(f"ОШИБКА: {contact.error}")
        else:
            email_count = len(contact.emails)
            print(f"OK — {email_count} email(s): {', '.join(contact.emails[:3]) or '—'}")

        if i < total:
            time.sleep(args.delay)

    write_results(contacts, output_path)

    found = sum(1 for c in contacts if c.emails)
    total_emails = sum(len(c.emails) for c in contacts)
    errors = sum(1 for c in contacts if c.error)

    print(f"\nГотово!")
    print(f"  Обработано:  {total}")
    print(f"  С email:     {found}")
    print(f"  Всего email: {total_emails}")
    print(f"  Ошибки:      {errors}")
    print(f"  Результат:   {output_path}")


if __name__ == "__main__":
    main()
