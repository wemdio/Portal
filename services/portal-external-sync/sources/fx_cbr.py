"""Курсы ЦБ → fx_rates.

Спрашиваем курс за каждую дату, где есть операция в валюте и своей строки в
fx_rates ещё нет, — ровно один раз за дату (память о запросах живёт в
fx_rate_probes). Дата запроса и дата публикации — разные вещи: в выходные и
праздники ЦБ отдаёт последний рабочий курс, и атрибут Date в ответе
указывает на него. Пишем строку под датой публикации, а витрина берёт
ближайший курс не позже даты операции — так выходные закрываются сами.

Источники валютных дат — brocard_transactions, manual_expenses,
bank_transactions и crypto_income_transfers (см. _OPERATION_DATES_SQL).
Крипта попала сюда вместе с источником crypto_usdt и требует оговорки: USDT
считается по курсу ДОЛЛАРА, подмена валюты сделана прямо в объединении дат —
подробности в комментарии там же. Место в SOURCES (main.py) обязывает:
CryptoUsdtSync стоит СТРОГО выше FxCbrSync, иначе курс за дату сегодняшнего
крипто-прихода будет запрошен только следующей ночью.

Раньше bank_tochka и bank_tbank сюда не входили вовсе:
оба банковских источника жёстко писали currency='RUB' (см.
map_transaction/map_operation), и валютных трат в bank_transactions не
бывало в принципе. С тех пор, как bank_tochka стал читать валюту из
Amount.currency вместо хардкода, это больше не так — нерублёвая банковская
операция редка, но возможна, и её тоже нужно учитывать: без курса её
amount_rub в expenses_v молча останется NULL навсегда. bank_tbank хардкод
тоже потерял: валюта его операций берётся из поля currency счёта, который
отдаёт сам банк (см. CURRENCY_BY_NUMERIC_CODE в sources/bank_tbank.py).

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

#: Окно "курс не устарел". Больше НЕ участвует в отборе дат (см.
#: _NEEDED_DATES_SQL) — осталось только в сводке "ЦБ не публикует курс
#: для…": там вопрос другой, не "есть ли курс за этот день", а "есть ли у
#: ЦБ такая валюта вообще". 10 дней выбрано по самому длинному реальному
#: разрыву в публикации ЦБ — новогодним каникулам (8 дней), с запасом.
_STALE_WINDOW_SQL = "interval '10 days'"

#: Все валютные операции, под которые может понадобиться курс: (дата, валюта).
#: Один текст на оба запроса ниже — раньше этот UNION был скопирован в них
#: дважды, и новый источник ничего не стоило дописать только в первый: даты
#: тогда запрашивались бы, а сводка «ЦБ не публикует курс для…» смотрела бы на
#: старый набор таблиц и молчала.
_OPERATION_DATES_SQL = """
      SELECT (occurred_at AT TIME ZONE 'Europe/Moscow')::date AS d, currency
      FROM brocard_transactions
      UNION ALL
      SELECT occurred_on AS d, currency
      FROM manual_expenses
      UNION ALL
      SELECT (occurred_at AT TIME ZONE 'Europe/Moscow')::date AS d, currency
      FROM bank_transactions
      WHERE currency <> 'RUB'
      UNION ALL
      -- Крипта. USDT считаем по курсу ДОЛЛАРА ЦБ и поэтому подменяем валюту
      -- прямо здесь: это осознанное упрощение, а не совпадение имён —
      -- стейблкоин привязан к доллару один к одному, и отдельный источник
      -- котировок под него владелец заводить не стал. Без подмены источник
      -- каждую ночь спрашивал бы у ЦБ несуществующий курс USDT, ничего не
      -- находил и печатал бы «ЦБ не публикует курс для: USDT», а amount_rub
      -- у крипты навсегда остался бы NULL.
      -- Ровно та же подмена продублирована в витрине incomes_v
      -- (supabase/migrations/20260731_0004_crypto_income.sql). Меняются оба
      -- места только вместе: разойдутся — курс будет запрашиваться под одну
      -- валюту, а искаться под другую.
      SELECT (occurred_at AT TIME ZONE 'Europe/Moscow')::date AS d,
             CASE WHEN currency = 'USDT' THEN 'USD' ELSE currency END AS currency
      FROM crypto_income_transfers
"""

_NEEDED_DATES_SQL = f"""
    SELECT DISTINCT d
    FROM (
{_OPERATION_DATES_SQL}
    ) x
    WHERE x.currency <> 'RUB'
      -- Будущих дат у операций быть не должно, но если такая заведётся
      -- руками (опечатка в manual_expenses), ходить за ней в ЦБ бессмысленно
      -- и вредно: ответ придётся пометить как отработанный, а курса за неё
      -- ещё не существует.
      AND x.d <= current_date
      -- Точное совпадение дат, а НЕ окно "есть курс не старше N дней".
      --
      -- Окно тут было и давало молча неверные суммы: 13.08 не запрашивался,
      -- потому что уже лежал курс за 12.08, и приход этого дня считался по
      -- позавчерашнему курсу. На боевых данных 30.08.2026 худший случай —
      -- операция 10.08 по курсу 31.07, отставание ровно 10 дней. Ни ошибки,
      -- ни NULL: отчёт выглядит полным, а деньги в нём неверные.
      --
      -- Точное совпадение само по себе зациклилось бы на выходных (за
      -- субботу ЦБ отдаёт пятничный курс под ПЯТНИЧНОЙ датой, и строки с
      -- rate_date = суббота не появится никогда). Поэтому цикл разрывает не
      -- окно, а память о самом запросе — fx_rate_probes ниже.
      AND NOT EXISTS (
        SELECT 1 FROM fx_rates f
        WHERE f.currency = x.currency
          AND f.rate_date = x.d
      )
      -- За эту дату в ЦБ уже ходили. Ответ пришёл и разобрался (запись в
      -- probes делается только после успешного upsert-а курсов), значит
      -- своей строки у даты нет и не будет — это выходной или праздник.
      -- Спрашивать второй раз не за чем.
      AND NOT EXISTS (
        SELECT 1 FROM fx_rate_probes p
        WHERE p.rate_date = x.d
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
{_OPERATION_DATES_SQL}
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

                    # Отметка «за эту дату сходили» — строго ПОСЛЕ успешной
                    # заливки курсов. Иначе дата, у которой ответ не
                    # разобрался, оказалась бы помечена отработанной и не
                    # переспросилась бы уже никогда.
                    #
                    # Для будней запись избыточна (курс за свою дату лежит в
                    # fx_rates и предикат закроется по нему), но пишется
                    # всегда: разделять случаи здесь — лишний if ради
                    # экономии одной строки в таблице на дату, а published_on
                    # рядом с rate_date как раз и объясняет постфактум,
                    # почему у выходного нет своего курса.
                    await conn.execute(
                        """INSERT INTO fx_rate_probes (rate_date, published_on)
                           VALUES ($1, $2)
                           ON CONFLICT (rate_date) DO UPDATE
                             SET probed_at = now(), published_on = EXCLUDED.published_on""",
                        d, published_on,
                    )
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
        # источника трат) никогда не получит строку в fx_rates. Даты при этом
        # помечены отработанными (probes), то есть повторных запросов не
        # будет и заметить дыру по логам станет неоткуда. Поэтому явно
        # называем, что не закрылось, даже после успешных запросов выше.
        still_missing = await conn.fetch(
            _STILL_MISSING_CURRENCIES_SQL, dates_to_process
        )
        if still_missing:
            currencies = sorted(row["currency"] for row in still_missing)
            print(
                f"[fx_cbr] ЦБ не публикует курс для: {', '.join(currencies)} — "
                f"fx_rates для них сам по себе не появится, суммы в этих "
                f"валютах останутся без рублёвого эквивалента, пока курс не "
                f"заведут вручную",
                flush=True,
            )

        return total
