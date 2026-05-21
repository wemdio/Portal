"""Trigga CSV parser.

Copied verbatim from polza_bot/trigga.py — only the imports point at models.py
instead of scraper.py.
"""
from __future__ import annotations

import csv
import re
from io import StringIO

from models import Campaign, CampaignAnalytics, LetterStat


def _parse_int(value: str | None) -> int:
    if not value:
        return 0
    value = value.replace("\xa0", "").replace(" ", "").strip()
    try:
        return int(float(value.replace(",", ".")))
    except ValueError:
        return 0


def _parse_pct(value: str | None) -> float:
    if not value:
        return 0.0
    value = value.replace("%", "").replace(",", ".").strip()
    try:
        return float(value)
    except ValueError:
        return 0.0


def _avg(values: list[float]) -> float:
    return round(sum(values) / len(values), 1) if values else 0.0


def _letter_parts(name: str) -> tuple[int, str | None]:
    match = re.search(r"письмо\s*#?\s*(\d+)(?:\s*\(([^)]+)\))?", name, re.IGNORECASE)
    if not match:
        return 9999, None
    number = int(match.group(1))
    variant = match.group(2).strip() if match.group(2) else None
    return number, variant


def _letter_from_row(row: dict[str, str], name: str, is_variant: bool = False) -> LetterStat:
    return LetterStat(
        name=name,
        sent=_parse_int(row.get("Отправлено")),
        opened=_parse_int(row.get("Открыто")),
        opened_pct=_parse_pct(row.get("Открыто, %")),
        replied=_parse_int(row.get("Ответы")),
        replied_pct=_parse_pct(row.get("Ответы, %")),
        is_variant=is_variant,
    )


def _build_letters(rows: list[dict[str, str]]) -> list[LetterStat]:
    by_step: dict[int, list[tuple[str | None, dict[str, str]]]] = {}
    for row in rows:
        raw_name = (row.get("Цепочка") or "").strip()
        step_number, variant = _letter_parts(raw_name)
        by_step.setdefault(step_number, []).append((variant, row))

    letters: list[LetterStat] = []
    for step_number in sorted(by_step):
        step_rows = by_step[step_number]
        has_variants = any(variant for variant, _ in step_rows)

        if has_variants:
            sent = sum(_parse_int(row.get("Отправлено")) for _, row in step_rows)
            opened = sum(_parse_int(row.get("Открыто")) for _, row in step_rows)
            replied = sum(_parse_int(row.get("Ответы")) for _, row in step_rows)
            letters.append(
                LetterStat(
                    name=f"Письмо {step_number}",
                    sent=sent,
                    opened=opened,
                    opened_pct=_avg([_parse_pct(row.get("Открыто, %")) for _, row in step_rows]),
                    replied=replied,
                    replied_pct=_avg([_parse_pct(row.get("Ответы, %")) for _, row in step_rows]),
                )
            )

            for variant, row in sorted(step_rows, key=lambda item: item[0] or ""):
                variant_name = f"Вариант {variant}" if variant else "Вариант"
                letters.append(_letter_from_row(row, variant_name, is_variant=True))
        else:
            _, row = step_rows[0]
            letters.append(_letter_from_row(row, f"Письмо {step_number}"))

    return letters


def parse_trigga_csv(data: bytes) -> list[Campaign]:
    text = data.decode("utf-8-sig")
    reader = csv.DictReader(StringIO(text))

    grouped: dict[str, list[dict[str, str]]] = {}
    for row in reader:
        campaign_name = (row.get("Компания") or "").strip()
        if not campaign_name:
            continue
        grouped.setdefault(campaign_name, []).append(row)

    campaigns: list[Campaign] = []
    for name, rows in grouped.items():
        leads_total = max(_parse_int(row.get("Лиды, кол-во")) for row in rows)
        sent_total = sum(_parse_int(row.get("Отправлено")) for row in rows)
        opened_total = sum(_parse_int(row.get("Открыто")) for row in rows)
        replied_total = sum(_parse_int(row.get("Ответы")) for row in rows)
        first_step_sent = sum(
            _parse_int(row.get("Отправлено"))
            for row in rows
            if (row.get("Цепочка") or "").strip().lower().startswith("письмо 1")
        )

        connected_reached = first_step_sent or min(sent_total, leads_total)
        opened_pct = round(opened_total / sent_total * 100, 1) if sent_total else 0.0
        replied_pct = round(replied_total / sent_total * 100, 1) if sent_total else 0.0

        letters = _build_letters(rows)

        campaigns.append(
            Campaign(
                name=name,
                status="—",
                created="",
                sent=sent_total,
                connected_reached=connected_reached,
                connected_total=leads_total,
                opened=opened_total,
                opened_pct=opened_pct,
                replied=replied_total,
                replied_pct=replied_pct,
                analytics=CampaignAnalytics(
                    connected=connected_reached,
                    opened=opened_total,
                    opened_pct=opened_pct,
                    replied=replied_total,
                    replied_pct=replied_pct,
                    interested=0,
                    interested_pct=0,
                    letters=letters,
                ),
            )
        )

    return sorted(campaigns, key=lambda campaign: campaign.name.lower())
