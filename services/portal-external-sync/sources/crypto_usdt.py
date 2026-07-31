"""USDT (TRC-20, сеть Tron) → crypto_income_transfers.

Тянем ТОЛЬКО входящие переводы (решение владельца): исходящие не нужны, и
никакого direction в таблице поэтому нет.

──────────────────────────────────────────────────────────────────────────
ЖИВАЯ ФОРМА ОТВЕТА TronGrid (проверено запросами к api.trongrid.io 31.07.2026)
──────────────────────────────────────────────────────────────────────────

Ручка: GET /v1/accounts/{address}/transactions/trc20
Параметры, которые реально работают:
  limit=200            — потолок страницы (больше не отдаёт);
  only_to=true         — только те записи, где наш адрес получатель;
  contract_address=…   — фильтр по контракту токена;
  min_timestamp=…      — нижняя граница в МИЛЛИСЕКУНДАХ;
  fingerprint=…        — курсор следующей страницы.

Конверт ответа:
  {"data": [...], "success": true,
   "meta": {"at": 1785514050946,
            "fingerprint": "TmGrm87pzf4z…",
            "links": {"next": "https://api.trongrid.io/v1/accounts/…"},
            "page_size": 2}}

Запись в data (полный набор ключей, других не встречается):
  {"transaction_id": "e37eb34143ca601453464d8ab9bc75f210f9529204353afd2adc112d27110211",
   "token_info": {"symbol": "USDT",
                  "address": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
                  "decimals": 6,
                  "name": "Tether USD"},
   "block_timestamp": 1785511209000,
   "from": "TJpNLFmEc6TKPauE4AQpEcsZ6ngrgrL783",
   "to": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
   "type": "Transfer",
   "value": "10000000000"}

Что из этого важно и на что легко наступить:

1. `value` приходит СТРОКОЙ и в минимальных единицах токена, а не в самом
   токене. "10000000000" при decimals=6 — это 10 000 USDT, а не десять
   миллиардов. Делим на 10**decimals и считаем в Decimal: float на шести
   знаках уже врёт, а это деньги.

2. `block_timestamp` — целое число МИЛЛИСЕКУНД от эпохи UTC, а не строка.
   Общий parse_date из _bank_common здесь принципиально неприменим: он режет
   аргумент до 19 символов и штампует UTC, то есть на числе 1785511209000
   даст либо None, либо мусор. Разбираем сами (см. parse_block_timestamp) —
   метка уже в UTC, смещения пояса в ней нет вовсе, и в базу она уходит
   честным timestamptz. В московскую дату её переводит витрина
   (AT TIME ZONE 'Europe/Moscow'), а не этот модуль.

3. `type` бывает НЕ ТОЛЬКО "Transfer". В живой выборке из 200 записей с
   only_to=true пришло 195 Transfer и 5 Approval. Approval — это выдача
   разрешения на списание, никаких денег не приходит, но у него тоже есть
   `value`, и без фильтра по type он лёг бы в базу выдуманным доходом.
   Фильтр по type обязателен.

4. Уникального идентификатора ПЕРЕВОДА эта ручка не отдаёт вовсе.
   `transaction_id` — хеш транзакции, и одна транзакция может нести
   несколько переводов токена: проверено на соседней ручке
   /v1/contracts/{contract}/events, где у транзакции e853aabe… два
   Transfer-лога с event_index 0 и 1 и разными суммами. Само поле
   event_index есть только там и в /accounts/…/transactions/trc20 не
   приходит. Поэтому идентификатор перевода собираем сами из содержимого —
   см. build_transfer_id. Порядковый номер записи в массиве для этого не
   годится: он поедет при смене порядка выдачи и на границе страниц.

5. Пагинация курсорная, а не по offset: `meta.fingerprint` — курсор,
   `meta.links.next` — уже готовый URL следующей страницы. Последняя
   страница приходит БЕЗ fingerprint и без links (проверено на пустом
   аккаунте: meta = {"at": …, "page_size": 0}). Ходим по своему набору
   параметров с подставленным fingerprint, а не по links.next: так фильтры
   (contract_address, only_to) гарантированно не теряются по дороге.

6. Несуществующий/неактивированный адрес — это НЕ ошибка: HTTP 200,
   success=true, data=[]. Отличить «кошелёк пуст» от «адрес неверен» по
   ответу нельзя, поэтому пустой прогон логируется явным сообщением.
"""
from __future__ import annotations

import json
import os
import traceback
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

import asyncpg
import httpx

from .base import SyncSource

API_BASE = "https://api.trongrid.io"

#: Кошелёк студии. Значения в репозитории нет намеренно — адрес приезжает
#: только из окружения (docker-compose.prod.yml). Пусто → NotImplementedError,
#: main.py залогирует прогон как 'partial' и пойдёт дальше.
WALLET_ADDRESS = os.environ.get("TRON_USDT_WALLET_ADDRESS", "").strip()

#: Ключ TronGrid необязателен: публичная ручка отвечает и без него, ключ лишь
#: поднимает лимит запросов. Есть — уходит заголовком TRON-PRO-API-KEY.
API_KEY = os.environ.get("TRONGRID_API_KEY", "").strip()

#: Контракт настоящего USDT в мейннете Tron. Не секрет и не настройка — это
#: константа протокола того же рода, что URL ЦБ в fx_cbr. Держим её здесь, а
#: не в окружении, именно чтобы её нельзя было тихо подменить: символ токена
#: в блокчейне никем не защищён, и скам-контракт может называть себя "USDT".
#: Отличает их только адрес контракта.
USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"

#: Потолок страницы у самой ручки.
PAGE_LIMIT = 200

#: Потолок страниц на прогон — 10 000 переводов. Нужен не ради экономии, а
#: как страховка от бесконечного цикла, если курсор вдруг перестанет
#: заканчиваться. Упёрлись в потолок — run() об этом печатает, а не молчит.
MAX_PAGES = 50

HTTP_TIMEOUT = 30


def parse_transfer_amount(value: object, decimals: object) -> Decimal | None:
    """`value` (строка минимальных единиц) + `decimals` → сумма в токене.

    None — значение непригодно, запись нужно пропустить. Молчаливый ноль
    здесь недопустим ровно по той же причине, что и в банковском
    coerce_amount: настоящий ноль и отсутствующая сумма — разные вещи.

    Считаем в Decimal, а не во float: у USDT шесть знаков после запятой, и
    float на суммах вида 30195.000001 уже врёт в последнем знаке. asyncpg
    кладёт Decimal в numeric(38,6) без потерь.

    Отрицательная сумма в TRC-20 невозможна (value — uint256), поэтому
    минус здесь означает не «расход», а испорченный ответ — такую запись
    пропускаем, а не пишем со знаком.
    """
    if value is None or decimals is None:
        return None
    if isinstance(decimals, bool) or not isinstance(decimals, int):
        return None
    if decimals < 0 or decimals > 32:
        return None
    try:
        units = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    if not units.is_finite() or units < 0:
        return None
    return units / (Decimal(10) ** decimals)


def parse_block_timestamp(value: object) -> datetime | None:
    """`block_timestamp` (целое число миллисекунд от эпохи UTC) → datetime с
    поясом UTC. None — метка непригодна.

    Общий parse_date из _bank_common сюда не годится в принципе: он ждёт
    строку, режет её до 19 символов и штампует UTC. На числовой метке в
    миллисекундах он вернул бы None, а если бы её кто-то предварительно
    привёл к строке — молча отрезал бы хвост и получил дату из другой эпохи.

    Складываем timedelta с эпохой, а не делим на 1000 во float: timedelta
    держит целые микросекунды и не теряет миллисекунды на округлении.

    Смещения пояса в метке нет вовсе — блокчейн живёт в UTC. В московскую
    дату её переводит витрина, а не этот модуль: тот же приём, что у
    банковских источников, где occurred_at тоже хранится в UTC.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        # Живой API отдаёт int. Строку принимаем на всякий случай, но только
        # целую — дробную метку разбирать вслепую нельзя, неизвестно, в чём
        # она (миллисекунды? секунды?).
        value = value.strip()
        if not value.lstrip("-").isdigit():
            return None
        value = int(value)
    if not isinstance(value, int):
        return None
    if value <= 0:
        return None
    try:
        return datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=value)
    except (OverflowError, ValueError):
        return None


def build_transfer_id(t: dict) -> str:
    """Идентификатор ПЕРЕВОДА (а не транзакции) из содержимого записи.

    Ручка /accounts/…/transactions/trc20 не отдаёт ни event_index, ни любой
    другой порядковый номер лога внутри транзакции, а одна транзакция может
    нести несколько переводов токена. Поэтому ключ собирается из того, что
    перевод внутри транзакции различает: контракт токена, отправитель,
    получатель, сумма в минимальных единицах.

    Порядковый номер записи в массиве для этого не годится: он зависит от
    порядка выдачи и разъедется на границе страниц, а ключ обязан быть
    одним и тем же при каждом прогоне — иначе UPSERT наплодит дубли.

    Остаточный риск: два одинаковых перевода (тот же отправитель, тот же
    получатель, ровно та же сумма) внутри ОДНОЙ транзакции схлопнутся в одну
    строку. Экономического смысла в такой паре нет — её дешевле сделать
    одним переводом на удвоенную сумму, — а ошибка при этом идёт в сторону
    занижения дохода, то есть заметна владельцу, а не льстит ему. Появится
    event_index в этой ручке — ключ надо переделать на transaction_id +
    event_index (и один раз пересчитать историю).
    """
    token = (t.get("token_info") or {}).get("address") or ""
    return ":".join((
        str(t.get("transaction_id") or ""),
        str(token),
        str(t.get("from") or ""),
        str(t.get("to") or ""),
        str(t.get("value") or ""),
    ))


def map_transfer(
    t: dict,
    wallet: str,
    skip_counts: dict[str, int] | None = None,
) -> dict | None:
    """Запись TronGrid → словарь полей crypto_income_transfers. None — пропустить.

    Непригодная запись пропускается с предупреждением в лог, а не роняет
    страницу целиком: одна кривая запись не должна уносить с собой всю
    историю кошелька. skip_counts, если передан, копит причины пропуска для
    сводки по прогону — тот же приём, что у банковских источников.

    Проверки идут от самых опасных к самым техническим:

    * type != "Transfer" — Approval и прочие события денег не приносят, но
      несут `value`; без этой отсечки они лягут выдуманным доходом;
    * контракт не USDT — символ токена в блокчейне не защищён, скам-токен
      может назваться "USDT"; доверяем адресу контракта, а не символу;
    * получатель не наш кошелёк — only_to=true это и так гарантирует, но
      если параметр когда-нибудь потеряется, исходящий перевод не должен
      молча превратиться в приход.
    """

    def _skip(reason: str, message: str) -> None:
        print(f"[crypto_usdt] skip {message}", flush=True)
        if skip_counts is not None:
            skip_counts[reason] = skip_counts.get(reason, 0) + 1

    tx_id = t.get("transaction_id")
    if not tx_id or not isinstance(tx_id, str):
        _skip("no_tx_id", f"запись без transaction_id: {t!r}")
        return None

    event_type = t.get("type")
    if event_type != "Transfer":
        # Не ошибка и не редкость: в живой выборке ~2.5% записей — Approval.
        _skip("not_a_transfer", f"tx={tx_id}: type={event_type!r}, не перевод")
        return None

    token_info = t.get("token_info") or {}
    contract = token_info.get("address")
    if contract != USDT_TRC20_CONTRACT:
        _skip("other_token", f"tx={tx_id}: контракт {contract!r}, а не USDT")
        return None

    to_address = t.get("to")
    if to_address != wallet:
        _skip("not_incoming", f"tx={tx_id}: получатель {to_address!r}, а не наш кошелёк")
        return None

    from_address = t.get("from")
    if not from_address or not isinstance(from_address, str):
        # Отправитель — единственный контрагент, который у крипты вообще
        # есть. Строка без него в витрине была бы анонимными деньгами.
        _skip("no_from", f"tx={tx_id}: нет адреса отправителя")
        return None

    amount = parse_transfer_amount(t.get("value"), token_info.get("decimals"))
    if amount is None:
        _skip(
            "bad_amount",
            f"tx={tx_id}: не разобралась сумма value={t.get('value')!r} "
            f"decimals={token_info.get('decimals')!r}",
        )
        return None

    occurred_at = parse_block_timestamp(t.get("block_timestamp"))
    if occurred_at is None:
        _skip(
            "bad_date",
            f"tx={tx_id}: не разобралась дата "
            f"block_timestamp={t.get('block_timestamp')!r}",
        )
        return None

    symbol = str(token_info.get("symbol") or "USDT").upper()

    return {
        "transfer_id": build_transfer_id(t),
        "transaction_id": tx_id,
        "network": "tron",
        "token_symbol": symbol,
        "token_contract": contract,
        "wallet_address": wallet,
        "from_address": from_address,
        "occurred_at": occurred_at,
        "amount": amount,
        "currency": symbol,
        "raw": json.dumps(t, ensure_ascii=False),
    }


#: Порядок колонок в INSERT — менять только вместе с _upsert().
COLUMNS: tuple[str, ...] = (
    "transfer_id", "transaction_id", "network", "token_symbol", "token_contract",
    "wallet_address", "from_address", "occurred_at", "amount", "currency", "raw",
)


def to_row(d: dict) -> tuple:
    """dict → кортеж в порядке COLUMNS для executemany."""
    return tuple(d[c] for c in COLUMNS)


class CryptoUsdtSync(SyncSource):
    name = "crypto_usdt"

    async def run(self, conn: asyncpg.Connection) -> int:
        if not WALLET_ADDRESS:
            raise NotImplementedError("TRON_USDT_WALLET_ADDRESS не задан")

        headers = {"Accept": "application/json"}
        if API_KEY:
            headers["TRON-PRO-API-KEY"] = API_KEY

        url = f"{API_BASE}/v1/accounts/{WALLET_ADDRESS}/transactions/trc20"
        params: dict[str, object] = {
            "limit": PAGE_LIMIT,
            "only_to": "true",
            "contract_address": USDT_TRC20_CONTRACT,
        }

        total = 0
        seen = 0
        pages = 0
        fingerprint: str | None = None
        skip_counts: dict[str, int] = {}
        hit_page_cap = False

        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, headers=headers) as client:
            for page in range(MAX_PAGES):
                # Единица работы — страница. Сбой одной (сеть, HTTP-ошибка,
                # неразбираемое тело) обрывает обход, но НЕ откатывает уже
                # залитые страницы: курсор после сбоя восстановить неоткуда,
                # а то, что доехало, полезнее пустого прогона. Следующей
                # ночью обход начнётся заново с первой страницы, UPSERT
                # сделает повтор безвредным.
                try:
                    page_params = dict(params)
                    if fingerprint:
                        page_params["fingerprint"] = fingerprint

                    resp = await client.get(url, params=page_params)
                    if resp.status_code >= 400:
                        print(
                            f"[crypto_usdt] страница {page + 1}: HTTP "
                            f"{resp.status_code}, обход прерван",
                            flush=True,
                        )
                        break

                    body = resp.json()
                except Exception as e:
                    print(
                        f"[crypto_usdt] страница {page + 1} FAIL: {e}\n"
                        f"{traceback.format_exc()}",
                        flush=True,
                    )
                    break

                records = body.get("data") or []
                seen += len(records)
                pages += 1

                mapped = [
                    m for m in (
                        map_transfer(t, WALLET_ADDRESS, skip_counts) for t in records
                    ) if m is not None
                ]
                if mapped:
                    await self._upsert(conn, [to_row(m) for m in mapped])
                    total += len(mapped)

                meta = body.get("meta") or {}
                next_fingerprint = meta.get("fingerprint")
                if not records or not next_fingerprint:
                    # Последняя страница приходит без fingerprint вовсе.
                    break
                if next_fingerprint == fingerprint:
                    # Курсор не сдвинулся — дальше был бы бесконечный цикл по
                    # одной и той же странице.
                    print(
                        f"[crypto_usdt] курсор не сдвинулся на странице "
                        f"{page + 1} — обход прерван",
                        flush=True,
                    )
                    break
                fingerprint = next_fingerprint
            else:
                hit_page_cap = True

        if hit_page_cap:
            print(
                f"[crypto_usdt] потолок {MAX_PAGES} страниц за прогон достигнут — "
                f"хвост истории останется до следующего прогона; если это не "
                f"первый бэкфилл, значит курсор не заканчивается",
                flush=True,
            )

        if skip_counts:
            total_skipped = sum(skip_counts.values())
            breakdown = ", ".join(
                f"{reason}={n}" for reason, n in sorted(skip_counts.items())
            )
            print(
                f"[crypto_usdt] skipped {total_skipped} record(s): {breakdown}",
                flush=True,
            )

        if seen == 0:
            # HTTP 200 + success=true + пустой data приходит и на пустой
            # кошелёк, и на несуществующий адрес — по ответу их не различить.
            # Молчать об этом нельзя: опечатка в TRON_USDT_WALLET_ADDRESS
            # выглядела бы как «доходов не было».
            print(
                f"[crypto_usdt] по адресу {WALLET_ADDRESS} не пришло ни одной "
                f"записи (пустой кошелёк или неверный адрес — по ответу "
                f"TronGrid это неразличимо)",
                flush=True,
            )
        else:
            print(
                f"[crypto_usdt] страниц: {pages}, записей в ответе: {seen}, "
                f"переводов записано: {total}",
                flush=True,
            )

        return total

    async def _upsert(self, conn: asyncpg.Connection, rows: list[tuple]) -> None:
        # UPDATE перезаписывает и сумму с датой, а не только raw: если разбор
        # ответа однажды исправят (например, изменится decimals у токена),
        # ближайший прогон вылечит уже приехавшую историю сам, а не оставит
        # её молча неверной.
        await conn.executemany(
            """INSERT INTO crypto_income_transfers (
                 transfer_id, transaction_id, network, token_symbol, token_contract,
                 wallet_address, from_address, occurred_at, amount, currency, raw
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
               ON CONFLICT (transfer_id) DO UPDATE SET
                 token_symbol = EXCLUDED.token_symbol,
                 occurred_at  = EXCLUDED.occurred_at,
                 amount       = EXCLUDED.amount,
                 currency     = EXCLUDED.currency,
                 raw          = EXCLUDED.raw,
                 synced_at    = now()""",
            rows,
        )
