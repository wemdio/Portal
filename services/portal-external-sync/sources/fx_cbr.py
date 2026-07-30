"""Курсы ЦБ → fx_rates.

Спрашиваем курс только за те даты, где реально есть траты в валюте и курса
ещё нет. Дата запроса и дата публикации — разные вещи: в выходные ЦБ отдаёт
последний рабочий курс, и атрибут Date в ответе указывает на него. Пишем
строку под датой публикации, а витрина берёт ближайший курс не позже даты
операции — так выходные закрываются сами.

Источники валютных дат — brocard_transactions, manual_expenses и
bank_transactions. Раньше bank_tochka и bank_tbank сюда не входили вовсе:
оба банковских источника жёстко писали currency='RUB' (см.
map_transaction/map_operation), и валютных трат в bank_transactions не
бывало в принципе. С тех пор, как bank_tochka стал читать валюту из
Amount.currency вместо хардкода, это больше не так — нерублёвая банковская
операция редка, но возможна, и её тоже нужно учитывать: без курса её
amount_rub в expenses_v молча останется NULL навсегда. bank_tbank по-прежнему
хардкодит RUB, но это не проблема — фильтр currency <> 'RUB' ниже просто не
заденет её строки.

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

#: Потолок на прогон, чтобы первый бэкфилл не превратился в тысячу запросов
#: за одну ночь. Если недостающих дат больше — часть достаётся следующим
#: прогонам, run() об этом печатает (см. ниже), а не молчит про хвост.
MAX_DATES_PER_RUN = 120

#: Окно "курс не устарел" для предиката отбора дат — см. комментарий у SQL
#: ниже про то, почему это окно, а не точное совпадение дат и не "хоть один
#: более ранний курс существует".
_STALE_WINDOW_SQL = "interval '10 days'"

_NEEDED_DATES_SQL = f"""
    SELECT DISTINCT d
    FROM (
      SELECT (occurred_at AT TIME ZONE 'Europe/Moscow')::date AS d, currency
      FROM brocard_transactions
      UNION ALL
      SELECT occurred_on AS d, currency
      FROM manual_expenses
      UNION ALL
      SELECT (occurred_at AT TIME ZONE 'Europe/Moscow')::date AS d, currency
      FROM bank_transactions
      WHERE currency <> 'RUB'
    ) x
    WHERE x.currency <> 'RUB'
      AND NOT EXISTS (
        -- Окно в 10 дней, а НЕ:
        --   (а) точное совпадение дат — ЦБ не публикует курс в выходные и
        --       праздники, и мы намеренно пишем строку под пятницей вместо
        --       субботы, поэтому rate_date = x.d для субботы никогда не
        --       будет true, и источник ходил бы в ЦБ за одной и той же
        --       субботой каждую ночь вечно;
        --   (б) "существует хоть один курс этой валюты с rate_date <= x.d"
        --       без нижней границы — это и есть баг, который тут был:
        --       после первой же загрузки валюты в fx_rates появляется одна
        --       строка, и она <= любой более поздней дате, поэтому ВСЕ
        --       будущие даты этой валюты считаются закрытыми навсегда —
        --       источник перестаёт ходить в ЦБ за свежим курсом, а витрина
        --       (join "ближайший курс не позже") тихо продолжает считать
        --       по этой годовалой строке. Дашборд выглядит полным (нет
        --       NULL, нет ошибок), а деньги в нём молча неверные.
        -- Правильное условие — "ближайший доступный курс для этой даты не
        -- устарел", то есть окно: rate_date <= x.d И rate_date не более чем
        -- на N дней раньше x.d. 10 дней выбрано по самому длинному реальному
        -- разрыву в публикации ЦБ — новогодним каникулам (8 дней), с
        -- запасом. Ошибка в сторону лишнего запроса к ЦБ безвредна —
        -- ON CONFLICT DO UPDATE делает повтор идемпотентным; ошибка в
        -- другую сторону (шире окно/без окна) даёт молча неверные суммы.
        -- Не сужать и не убирать нижнюю границу.
        SELECT 1 FROM fx_rates f
        WHERE f.currency = x.currency
          AND f.rate_date <= x.d
          AND f.rate_date >= x.d - {_STALE_WINDOW_SQL}
      )
    ORDER BY d
"""

# Тот же предикат, что и выше, но ограниченный конкретными датами: зовётся
# после того, как для dates_to_process уже сходили в ЦБ, чтобы понять, какие
# валюты так и остались без курса — сигнал "у ЦБ такой валюты вообще нет",
# а не "ещё не успели дойти".
_STILL_MISSING_CURRENCIES_SQL = f"""
    SELECT DISTINCT x.currency
    FROM (
      SELECT (occurred_at AT TIME ZONE 'Europe/Moscow')::date AS d, currency
      FROM brocard_transactions
      UNION ALL
      SELECT occurred_on AS d, currency
      FROM manual_expenses
      UNION ALL
      SELECT (occurred_at AT TIME ZONE 'Europe/Moscow')::date AS d, currency
      FROM bank_transactions
      WHERE currency <> 'RUB'
    ) x
    WHERE x.currency <> 'RUB'
      AND x.d = ANY($1::date[])
      AND NOT EXISTS (
        SELECT 1 FROM fx_rates f
        WHERE f.currency = x.currency
          AND f.rate_date <= x.d
          AND f.rate_date >= x.d - {_STALE_WINDOW_SQL}
      )
"""


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
        needed = await conn.fetch(_NEEDED_DATES_SQL)
        if not needed:
            return 0

        all_dates: list[date] = sorted(row["d"] for row in needed)
        total_dates_needed = len(all_dates)
        dates_to_process = all_dates[:MAX_DATES_PER_RUN]

        if total_dates_needed > MAX_DATES_PER_RUN:
            remaining = total_dates_needed - MAX_DATES_PER_RUN
            print(
                f"[fx_cbr] лимит {MAX_DATES_PER_RUN} дат за прогон достигнут: "
                f"обработано {MAX_DATES_PER_RUN} из {total_dates_needed}, "
                f"ещё {remaining} дата(ы) — в следующих прогонах",
                flush=True,
            )

        total = 0
        skip_counts: dict[str, int] = {}

        async with httpx.AsyncClient(timeout=30) as client:
            for d in dates_to_process:
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

        # Валюта вне ежедневного списка ЦБ (или опечатка в currency у
        # источника трат) никогда не получит строку в fx_rates, и с окном
        # вместо "любой более ранний курс" источник будет молча стучаться в
        # ЦБ за ней каждую ночь без единого сигнала. Явно называем, что не
        # закрылось, даже после успешных запросов выше.
        still_missing = await conn.fetch(
            _STILL_MISSING_CURRENCIES_SQL, dates_to_process
        )
        if still_missing:
            currencies = sorted(row["currency"] for row in still_missing)
            print(
                f"[fx_cbr] ЦБ не публикует курс для: {', '.join(currencies)} — "
                f"fx_rates для них не появится сам по себе, эти валюты будут "
                f"запрашиваться каждый прогон, пока курс не заведут вручную",
                flush=True,
            )

        return total
