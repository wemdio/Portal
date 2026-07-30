"""Курсы ЦБ → fx_rates.

Спрашиваем курс только за те даты, где реально есть траты в валюте и курса
ещё нет. Дата запроса и дата публикации — разные вещи: в выходные ЦБ отдаёт
последний рабочий курс, и атрибут Date в ответе указывает на него. Пишем
строку под датой публикации, а витрина берёт ближайший курс не позже даты
операции — так выходные закрываются сами.

Непригодный ответ за одну дату (сеть, HTTP-ошибка, тело не парсится) не
должен ронять остальные даты прогона — та же изоляция «единица работы =
одна дата», что у банковских источников.
"""
from __future__ import annotations

import traceback
import xml.etree.ElementTree as ET
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

import asyncpg
import httpx

from .base import SyncSource

API_URL = "https://www.cbr.ru/scripts/XML_daily.asp"

#: Потолок на прогон, чтобы первый бэкфилл не превратился в тысячу запросов.
MAX_DATES_PER_RUN = 120


def parse_cbr_xml(text: str) -> tuple[date, dict[str, Decimal]]:
    """XML ЦБ → (дата публикации, {код валюты: рублей за единицу}).

    Value приходит с запятой как десятичным разделителем, а не с точкой.
    Nominal у части валют не 1 (у юаня — 10): без деления на него курс
    завышен ровно в Nominal раз. Запись без CharCode (не под каким ключом
    класть в fx_rates) или без Value (нечего делить) — пропускается, а не
    роняет разбор всего ответа.
    """
    root = ET.fromstring(text)
    published_on = datetime.strptime(root.attrib["Date"], "%d.%m.%Y").date()

    rates: dict[str, Decimal] = {}
    for valute in root.findall("Valute"):
        code = (valute.findtext("CharCode") or "").strip()
        value = (valute.findtext("Value") or "").strip().replace(",", ".")
        nominal = (valute.findtext("Nominal") or "1").strip().replace(",", ".")
        if not code or not value:
            continue
        try:
            rates[code] = Decimal(value) / Decimal(nominal)
        except (InvalidOperation, ZeroDivisionError):
            continue
    return published_on, rates


class FxCbrSync(SyncSource):
    name = "fx_cbr"

    async def run(self, conn: asyncpg.Connection) -> int:
        needed = await conn.fetch(
            """
            SELECT DISTINCT d
            FROM (
              SELECT (occurred_at AT TIME ZONE 'Europe/Moscow')::date AS d, currency
              FROM brocard_transactions
              UNION ALL
              SELECT occurred_on AS d, currency
              FROM manual_expenses
            ) x
            WHERE x.currency <> 'RUB'
              AND NOT EXISTS (
                SELECT 1 FROM fx_rates f
                WHERE f.currency = x.currency AND f.rate_date <= x.d
              )
            ORDER BY d
            LIMIT $1
            """,
            MAX_DATES_PER_RUN,
        )
        if not needed:
            return 0

        total = 0
        skip_counts: dict[str, int] = {}

        async with httpx.AsyncClient(timeout=30) as client:
            for row in needed:
                d: date = row["d"]
                # Изоляция даты: сбой одного ответа ЦБ (сеть, HTTP-ошибка,
                # неразбираемое тело) не должен обрывать остальные даты
                # прогона — источник обязан дойти до конца и залить то, что
                # удалось разобрать.
                try:
                    resp = await client.get(API_URL, params={"date_req": d.strftime("%d/%m/%Y")})
                    if resp.status_code >= 400:
                        print(
                            f"[fx_cbr] skip date_req={d.isoformat()}: HTTP {resp.status_code}",
                            flush=True,
                        )
                        skip_counts["http_error"] = skip_counts.get("http_error", 0) + 1
                        continue

                    try:
                        published_on, rates = parse_cbr_xml(resp.text)
                    except (ET.ParseError, KeyError, ValueError) as e:
                        # Тело пришло, но не разобралось: битый XML, либо в
                        # корне нет ожидаемого атрибута Date.
                        print(
                            f"[fx_cbr] skip date_req={d.isoformat()}: тело не разобралось — {e}",
                            flush=True,
                        )
                        skip_counts["unparsable"] = skip_counts.get("unparsable", 0) + 1
                        continue

                    if not rates:
                        print(
                            f"[fx_cbr] skip date_req={d.isoformat()}: ни одной валюты в ответе",
                            flush=True,
                        )
                        skip_counts["empty"] = skip_counts.get("empty", 0) + 1
                        continue

                    await conn.executemany(
                        """INSERT INTO fx_rates (rate_date, currency, rate, source)
                           VALUES ($1, $2, $3, 'cbr')
                           ON CONFLICT (rate_date, currency) DO UPDATE
                             SET rate = EXCLUDED.rate, fetched_at = now()""",
                        [(published_on, code, rate) for code, rate in rates.items()],
                    )
                    total += len(rates)
                except Exception as e:
                    print(
                        f"[fx_cbr] date_req={d.isoformat()} FAIL: {e}\n{traceback.format_exc()}",
                        flush=True,
                    )
                    skip_counts["error"] = skip_counts.get("error", 0) + 1

        if skip_counts:
            total_skipped = sum(skip_counts.values())
            breakdown = ", ".join(
                f"{reason}={n}" for reason, n in sorted(skip_counts.items())
            )
            print(
                f"[fx_cbr] skipped {total_skipped} date(s): {breakdown}",
                flush=True,
            )

        return total
