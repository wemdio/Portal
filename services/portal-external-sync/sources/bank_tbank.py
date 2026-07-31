"""Т-Банк → bank_transactions.

Тянет операции по нашим счетам в обе стороны: recipientAccount == наш счёт →
приход (с классификатором выручки), payerAccount == наш счёт → расход.
Операция, где нашего счёта нет ни с одной стороны, — не наша, пропускается.
Классификатор «выручка / не выручка» — общий с Точкой, из _bank_common.
UPSERT по (bank='tbank', transaction_id).

Токенов может быть несколько — по одному на каждый бизнес студии в Т-Банке
(имена переменных окружения перечислены в TOKEN_ENV_VARS). Счета не задаются
конфигом и никогда не задавались осмысленно: раньше номер счёта был константой
в исходнике, и второму бизнесу она не подошла бы — это счёт первого. Теперь
для каждого токена счета спрашиваются у самого банка (GET /bank-accounts), и
источник идёт по всем, что тот вернул.

Валюта операции — валюта её счёта: у самой операции поля валюты в ответе нет,
а у счёта есть числовой код ISO 4217 (см. CURRENCY_BY_NUMERIC_CODE). Счёт с
неизвестным кодом пропускается целиком и громко — молчаливый дефолт в рубли
завысил бы рублёвый итог витрины.

Изоляция сбоя — три уровня: токен, счёт, период. Упавший токен не уносит
остальные токены, упавший счёт — остальные счета того же токена, упавший
период — остальные периоды. Значение токена в лог не попадает ни при каких
ошибках: в сообщениях токен назван именем своей переменной окружения, а тексты
исключений и трейсбеки прогоняются через redact_tokens.
"""
from __future__ import annotations

import json
import os
import traceback
from collections.abc import Mapping
from datetime import date
from typing import NamedTuple

import asyncpg
import httpx

from .base import SyncSource
from ._bank_common import classify_revenue, coerce_amount, parse_date, to_row

#: Переменные окружения с токенами Т-Банка — по одному токену на бизнес.
#: Третий бизнес добавляется дописыванием сюда ещё одного имени: всё
#: остальное в источнике уже работает по списку, а не по одному токену.
TOKEN_ENV_VARS: tuple[str, ...] = ("TBANK_TOKEN", "TBANK_TOKEN_2")

API_BASE = "https://business.tbank.ru/openapi/api/v1"
#: Список счетов токена. Живая проверка 31.07.2026: отдаёт голый массив;
#: путей /accounts и /company/accounts не существует (404).
ACCOUNTS_URL = f"{API_BASE}/bank-accounts"
API_URL = f"{API_BASE}/bank-statement"

#: Числовой код валюты (ISO 4217) → буквенный. Счёт Т-Банка отдаёт валюту
#: числом ("643"), а bank_transactions.currency хранит буквенный код — тот
#: же, что пишет Точка и с которым работают витрина расходов и курсы ЦБ.
#: Сегодня все счета студии рублёвые; остальные коды здесь на случай, когда
#: это перестанет быть правдой, и дописываются по мере надобности.
CURRENCY_BY_NUMERIC_CODE: dict[str, str] = {
    "643": "RUB",
    "840": "USD",
    "978": "EUR",
}

PERIODS = [
    ("2023-01-01", "2023-12-31"),
    ("2024-01-01", "2024-12-31"),
    ("2025-01-01", "2025-12-31"),
    ("2026-01-01", date.today().isoformat()),
]


class BankAccount(NamedTuple):
    """Счёт, каким его отдал банк: номер + буквенный код валюты."""

    number: str
    currency: str


def load_tokens(env: Mapping[str, str] | None = None) -> list[tuple[str, str]]:
    """[(имя переменной, значение токена), ...] — только непустые, в порядке
    TOKEN_ENV_VARS.

    Имя переменной, а не значение, дальше служит идентификатором токена во
    всех логах источника: значение не должно попасть в лог ни при каких
    обстоятельствах (см. redact_tokens).
    """
    source = os.environ if env is None else env
    tokens: list[tuple[str, str]] = []
    for name in TOKEN_ENV_VARS:
        value = (source.get(name) or "").strip()
        if value:
            tokens.append((name, value))
    return tokens


def redact_tokens(text: str, env: Mapping[str, str] | None = None) -> str:
    """Затирает значения токенов в тексте, который пойдёт в лог.

    Токен живёт в заголовке Authorization, а не в URL, поэтому в обычных
    сообщениях httpx его нет. Но «сегодня нет» и «не будет никогда» — разные
    вещи: чужой код в трейсбеке (repr заголовков, собственное исключение
    какой-нибудь библиотеки с подставленным значением) может протащить токен
    в лог. Затереть один раз на выходе дешевле, чем каждый раз доказывать,
    что не протащит.
    """
    for _, token in load_tokens(env):
        text = text.replace(token, "<redacted>")
    return text


def _fail_details(e: BaseException) -> str:
    """Текст исключения + трейсбек, с затёртыми значениями токенов."""
    return redact_tokens(f"{e}\n{traceback.format_exc()}")


def currency_from_numeric_code(code: object) -> str | None:
    """Числовой код валюты счёта → буквенный код, либо None, если неизвестен.

    None означает «мы не знаем, что это за валюта», и вызывающий обязан
    пропустить такой счёт целиком, а не считать его рублёвым. Раньше валюта
    была захардкожена строкой "RUB" в map_operation; молчаливый дефолт в
    рубли — ровно та же ошибка, только переехавшая на уровень выше: нерублёвая
    сумма легла бы в рублёвый итог витрины как есть и завысила бы его.
    """
    if code is None:
        return None
    text = str(code).strip()
    if not text:
        return None
    if text.isdigit():
        # ISO 4217 — трёхзначный код; "8" и "008" это одно и то же.
        text = text.zfill(3)
    return CURRENCY_BY_NUMERIC_CODE.get(text)


def parse_accounts(payload: object, token_label: str = "?") -> list[BankAccount]:
    """Ответ GET /bank-accounts → список пригодных к синку счетов.

    Чистая функция (только разбор и логи, без сети) — так её можно проверить
    на живом образце ответа. Образец, снятый 31.07.2026:

        [{"accountNumber": "40802810600001780269", "currency": "643",
          "balance": {"otb": 456529.5, "authorized": 0,
                      "pendingPayments": 0, "pendingRequisitions": 0}}]

    Непригодные записи отбрасываются поштучно, с логом на каждую, а не роняют
    разбор целиком: один странный счёт не должен лишить бизнес остальных.
    Счёт с неизвестным кодом валюты — отдельный случай, он пропускается
    громко: тихо посчитать его рублёвым значит завысить рублёвый итог.
    Дубликаты по номеру схлопываются, чтобы один счёт не отсинкался дважды и
    не удвоил счётчик залитых строк.
    """
    if not isinstance(payload, list):
        print(
            f"[bank_tbank] {token_label}: ответ /bank-accounts не список "
            f"({type(payload).__name__}) — ни одного счёта не разобрано",
            flush=True,
        )
        return []

    accounts: list[BankAccount] = []
    seen: set[str] = set()
    for entry in payload:
        if not isinstance(entry, dict):
            print(
                f"[bank_tbank] {token_label}: пропускаю счёт — запись не объект: "
                f"{entry!r}",
                flush=True,
            )
            continue

        number = str(entry.get("accountNumber") or "").strip()
        if not number:
            print(
                f"[bank_tbank] {token_label}: пропускаю счёт без accountNumber: "
                f"{entry!r}",
                flush=True,
            )
            continue

        currency = currency_from_numeric_code(entry.get("currency"))
        if currency is None:
            print(
                f"[bank_tbank] {token_label}: ПРОПУСКАЮ СЧЁТ ЦЕЛИКОМ "
                f"acc={number}: неизвестный код валюты "
                f"{entry.get('currency')!r}. Операции этого счёта не попадут в "
                f"базу, пока код не добавлен в CURRENCY_BY_NUMERIC_CODE — "
                f"считать его рублёвым нельзя, это завысит рублёвый итог",
                flush=True,
            )
            continue

        if number in seen:
            continue
        seen.add(number)
        accounts.append(BankAccount(number, currency))

    return accounts


def map_operation(
    o: dict,
    account: str,
    currency: str,
    skip_counts: dict[str, int] | None = None,
) -> dict | None:
    """Операция Т-Банка → словарь полей bank_transactions. None — пропустить.

    У Т-Банка нет поля-индикатора направления, как у Точки: направление
    определяем по тому, какой стороной стоит наш счёт. recipientAccount ==
    наш счёт → приход, payerAccount == наш счёт → расход, ни там ни там —
    операция не наша.

    currency — буквенный код валюты счёта (см. parse_accounts). Параметр
    обязательный и намеренно без значения по умолчанию: у операции своего
    поля валюты в ответе нет, её задаёт счёт, а раньше здесь стояла
    константа "RUB", из-за которой нерублёвая операция молча легла бы в базу
    рублёвой.

    Классификатор «выручка / не выручка» осмыслен только для прихода: у
    расхода нет плательщика-клиента, и прогонять по нему classify_revenue
    значит записывать в exclude_reason случайный мусор.

    Непригодная запись (не разобралась дата или сумма) пропускается с
    предупреждением в лог, а не роняет вызывающий батч: перед бэкфиллом за
    2023 год одна битая строка не должна уносить с собой весь период.
    skip_counts, если передан, копит причины пропуска для сводки по прогону.

    Чужая операция (наш счёт не с одной из сторон) считается в skip_counts
    под причиной "not_ours" без построчного лога — их много, и без счётчика
    молчаливая опечатка в имени поля API (например, если ответ вдруг придёт
    не с payerAccount, а с другим ключом) выглядела бы как "за период не
    было расходов", а не как поломка маппинга.
    """
    is_credit = o.get("recipientAccount") == account
    is_debit = o.get("payerAccount") == account
    if not is_credit and not is_debit:
        if skip_counts is not None:
            skip_counts["not_ours"] = skip_counts.get("not_ours", 0) + 1
        return None

    # Номер счёта в запасном варианте обязателен: у операций разных счетов
    # id может совпасть, и без него они схлопнулись бы в одну строку по
    # уникальному ключу (bank, transaction_id).
    tx_id = o.get("operationId") or f"{account}|{o.get('id')}"

    occurred_at = parse_date(o.get("date", ""))
    if occurred_at is None:
        print(
            f"[bank_tbank] skip operationId={tx_id!r}: не разобралась дата "
            f"date={o.get('date')!r}",
            flush=True,
        )
        if skip_counts is not None:
            skip_counts["bad_date"] = skip_counts.get("bad_date", 0) + 1
        return None

    amount = coerce_amount(o.get("amount"))
    if amount is None:
        print(
            f"[bank_tbank] skip operationId={tx_id!r}: не разобралась сумма "
            f"amount={o.get('amount')!r}",
            flush=True,
        )
        if skip_counts is not None:
            skip_counts["bad_amount"] = skip_counts.get("bad_amount", 0) + 1
        return None

    purpose = o.get("paymentPurpose", "") or ""
    payer = (o.get("payerName") or "") if is_credit else ""
    payer_inn = (o.get("payerInn") or "") if is_credit else ""
    payee = "" if is_credit else (o.get("recipient") or "")
    payee_inn = "" if is_credit else (o.get("recipientInn") or "")

    exclude_reason = classify_revenue(payer, payer_inn, purpose) if is_credit else ""
    is_revenue = (not exclude_reason) if is_credit else None

    return {
        "bank": "tbank",
        "account_id": account,
        "transaction_id": str(tx_id),
        "document_number": str(o.get("id")) if o.get("id") is not None else None,
        "occurred_at": occurred_at,
        "amount": amount,
        "currency": currency,
        "direction": "credit" if is_credit else "debit",
        "payer_name": payer or None,
        "payer_inn": payer_inn or None,
        "payee_name": payee or None,
        "payee_inn": payee_inn or None,
        "purpose": purpose or None,
        "is_revenue": is_revenue,
        "exclude_reason": exclude_reason or None,
        "raw": json.dumps(o, ensure_ascii=False),
    }


def reconcile_period_totals(
    rows: list[dict], data: dict, tolerance: float = 0.01, account: str | None = None
) -> list[str]:
    """Сверяет сумму замапленных операций периода с income/outcome, которые
    банк сам посчитал за тот же период в ответе /bank-statement.

    Это единственная доступная проверка полноты выгрузки: у ручки нет ни
    курсора, ни total — раньше расхождение с ожидаемым числом операций можно
    было объяснить только подозрением на пагинацию. Если сумма замапленных
    приходов/расходов не сходится с income/outcome банка, часть операций до
    базы не доехала (сетевой сбой периода, битая дата/сумма и т.п.) — то же
    самое, что раньше пытались ловить пагинацией, только без домыслов о её
    существовании.

    rows — словари после map_operation (до to_row), т.е. уже без
    отфильтрованных/пропущенных операций. data — сырой ответ API за период.

    account — номер счёта, к которому относится этот ответ банка. income и
    outcome посчитаны банком по одному конкретному счёту, поэтому сверка
    обязана оставаться в границах «токен + счёт + период»: если передан,
    rows дополнительно фильтруются по account_id, и номер счёта попадает в
    текст предупреждения. Свалить операции разных счетов в общий котёл
    значит сравнивать их сумму с итогом одного счёта — проверка перестанет
    что-либо проверять и начнёт врать в обе стороны. Значение по умолчанию
    None (без фильтра и без номера в сообщении) оставлено только ради
    вызовов, где счёт неизвестен; run() всегда передаёт его явно.

    Сравнение — с допуском tolerance (по умолчанию копейка), не точное
    равенство float. Если банк не прислал income или outcome в ответе,
    сверка по этому полю молча пропускается — отсутствие поля не ошибка.
    """
    warnings: list[str] = []

    if account is not None:
        rows = [r for r in rows if r.get("account_id") == account]
    prefix = f"acc={account} " if account is not None else ""

    income = data.get("income")
    if income is not None:
        mapped_income = sum(r["amount"] for r in rows if r["direction"] == "credit")
        diff = mapped_income - float(income)
        if abs(diff) > tolerance:
            warnings.append(
                f"{prefix}income mismatch: bank={income} "
                f"mapped={mapped_income} diff={diff:+.2f}"
            )

    outcome = data.get("outcome")
    if outcome is not None:
        mapped_outcome = sum(r["amount"] for r in rows if r["direction"] == "debit")
        diff = mapped_outcome - float(outcome)
        if abs(diff) > tolerance:
            warnings.append(
                f"{prefix}outcome mismatch: bank={outcome} "
                f"mapped={mapped_outcome} diff={diff:+.2f}"
            )

    return warnings


class BankTBankSync(SyncSource):
    name = "bank_tbank"

    async def run(self, conn: asyncpg.Connection) -> int:
        tokens = load_tokens()
        if not tokens:
            raise NotImplementedError(
                "ни один токен Т-Банка не задан: " + ", ".join(TOKEN_ENV_VARS)
            )

        total = 0
        skip_counts: dict[str, int] = {}

        for label, token in tokens:
            # Изоляция токена: сбой одного бизнеса не должен уносить синк
            # остальных. Токен опознаётся именем переменной, не значением.
            try:
                total += await self._sync_token(conn, label, token, skip_counts)
            except Exception as e:
                print(
                    f"[bank_tbank] token FAIL {label}: {_fail_details(e)}",
                    flush=True,
                )

        if skip_counts:
            # Сводка пропусков — общая за прогон, по всем токенам и счетам.
            total_skipped = sum(skip_counts.values())
            breakdown = ", ".join(
                f"{reason}={n}" for reason, n in sorted(skip_counts.items())
            )
            print(
                f"[bank_tbank] skipped {total_skipped} record(s): {breakdown}",
                flush=True,
            )

        return total

    async def _sync_token(
        self,
        conn: asyncpg.Connection,
        label: str,
        token: str,
        skip_counts: dict[str, int],
    ) -> int:
        """Все счета одного токена. Возвращает число залитых строк."""
        headers = {"Authorization": f"Bearer {token}"}
        total = 0

        async with httpx.AsyncClient(timeout=120, headers=headers) as client:
            try:
                resp = await client.get(ACCOUNTS_URL)
                resp.raise_for_status()
                payload = resp.json()
            except Exception as e:
                # Не смогли спросить счета — переходим к следующему токену.
                # Остальные бизнесы синкаются как обычно, источник не падает.
                print(
                    f"[bank_tbank] {label}: не удалось получить список счетов: "
                    f"{_fail_details(e)}",
                    flush=True,
                )
                return 0

            accounts = parse_accounts(payload, label)
            if not accounts:
                print(
                    f"[bank_tbank] {label}: банк не вернул ни одного пригодного "
                    f"счёта — синкать нечего",
                    flush=True,
                )
                return 0

            print(
                f"[bank_tbank] {label}: счетов {len(accounts)}: "
                + ", ".join(f"{a.number} ({a.currency})" for a in accounts),
                flush=True,
            )

            for account in accounts:
                # Изоляция счёта: сбой одного счёта не уносит остальные счета
                # того же токена.
                try:
                    total += await self._sync_account(
                        conn, client, label, account, skip_counts
                    )
                except Exception as e:
                    print(
                        f"[bank_tbank] account FAIL {label} acc={account.number}: "
                        f"{_fail_details(e)}",
                        flush=True,
                    )

        return total

    async def _sync_account(
        self,
        conn: asyncpg.Connection,
        client: httpx.AsyncClient,
        label: str,
        account: BankAccount,
        skip_counts: dict[str, int],
    ) -> int:
        """Все периоды одного счёта. Возвращает число залитых строк."""
        total = 0

        for frm, till in PERIODS:
            # Изоляция периода: сбой одного периода (сеть, битые данные,
            # ошибка upsert) не должен обрывать остальные — источник обязан
            # дойти до конца и залить то, что удалось.
            try:
                resp = await client.get(
                    API_URL,
                    params={
                        "accountNumber": account.number,
                        "from": frm,
                        "till": till,
                    },
                )
                if resp.status_code >= 400:
                    # Пропускаем период с ошибкой — не валим весь синк.
                    print(
                        f"[bank_tbank] {label} acc={account.number} {frm}..{till}: "
                        f"HTTP {resp.status_code} — период пропущен",
                        flush=True,
                    )
                    continue
                data = resp.json()

                mapped_rows: list[dict] = []
                for o in data.get("operation", []) or []:
                    mapped = map_operation(
                        o, account.number, account.currency, skip_counts
                    )
                    if mapped is not None:
                        mapped_rows.append(mapped)
                if mapped_rows:
                    await self._upsert(conn, [to_row(m) for m in mapped_rows])
                    total += len(mapped_rows)

                for warning in reconcile_period_totals(
                    mapped_rows, data, account=account.number
                ):
                    print(
                        f"[bank_tbank] {label} {frm}..{till}: {warning}",
                        flush=True,
                    )
            except Exception as e:
                print(
                    f"[bank_tbank] period FAIL {label} acc={account.number} "
                    f"{frm}..{till}: {_fail_details(e)}",
                    flush=True,
                )

        return total

    async def _upsert(self, conn: asyncpg.Connection, rows: list[tuple]) -> None:
        await conn.executemany(
            """INSERT INTO bank_transactions (
                 bank, account_id, transaction_id, document_number,
                 occurred_at, amount, currency, direction,
                 payer_name, payer_inn, payee_name, payee_inn,
                 purpose, is_revenue, exclude_reason, raw
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
               ON CONFLICT (bank, transaction_id) DO UPDATE SET
                 direction      = EXCLUDED.direction,
                 payee_name     = EXCLUDED.payee_name,
                 payee_inn      = EXCLUDED.payee_inn,
                 is_revenue     = EXCLUDED.is_revenue,
                 exclude_reason = EXCLUDED.exclude_reason,
                 raw            = EXCLUDED.raw,
                 synced_at      = now()""",
            rows,
        )
