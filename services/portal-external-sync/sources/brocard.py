"""Brocard (виртуальные карты) → brocard_transactions.

Расходная сторона одной карты владельца: покупки, комиссии за них, комиссии
за отклонённые попытки и возвраты. Строка таблицы = движение по балансу карты
(GET /api/v2/balance/history), потому что только там есть комиссии: в
/api/v2/payments лежит сама покупка и мерчант, но ни одной комиссии. Комиссий
на живом аккаунте больше, чем покупок (100 payment_fee + 40
declined_payment_fee против 89 payment), так что источник, построенный на
одних платежах, занизил бы расход примерно вдвое.

Мерчант при этом есть только в /payments. Обе ручки поэтому читаются целиком,
и движение баланса связывается с платежом по своему полю based_on_id:
у payment это сам платёж, у payment_fee и declined_payment_fee — платёж, за
который взята комиссия, у payment_void — гасимый платёж. Мерчант (и имя
держателя, и статус платежа) переносится на движение из связанного платежа —
именно так комиссия попадает в разбивку расходов под именем сервиса, а не в
безымянную кучу «комиссии».

СЕРВЕРНЫЙ ФИЛЬТР ПО КАРТЕ НЕ ТРОГАТЬ КАК ЕДИНСТВЕННЫЙ ОТБОР. Живая проверка
/api/v2/payments с card=2660444 вернула платёж карты 2618593 — параметр
проигнорирован. Поэтому:
  * /payments читается вообще без фильтра (индекс платежей нужен целиком —
    по нему опознаются и чужие карты тоже);
  * /balance/history запрашивается с card=<id> как подсказкой, но каждая
    строка проверяется на нашей стороне (см. owner_card), и run() печатает,
    сколько чужих строк пришло в ответ на фильтр — то есть работает ли он
    вообще, видно в логе прогона, а не в чьей-то памяти.

Принадлежность движения карте доказывается, а не предполагается: через
связанный платёж (card.id) либо через поля account/account_number самого
движения. Недоказуемое движение НЕ пишется и громко считается отдельным
счётчиком: молча записать чужую трату хуже, чем громко потерять свою —
первое портит суммы дашборда неотличимо от правды.

Пагинация одинаковая у всех трёх ручек: per_page (до 1000) + page (с 1), в
ответе data/total/per_page/current_page/last_page.

Суммы: /balance/history отдаёт их строкой и со знаком ("-0.88" у расхода).
В базу кладём модуль со знаком, который нужен витрине expenses_v (она просто
складывает amount): трата — положительная, возврат (payment_void) —
отрицательная, чтобы он гасил ранее учтённую трату, а не добавлял доход.
Направление и тип операции хранятся отдельными колонками (миграция
20260731_0003_brocard_fields.sql), сумма без них не читается.

Незнакомый тип прихода не вычитается вслепую: строка пропускается и попадает
в сводку с именем типа. Если Brocard заведёт, например, пополнение карты,
молчаливое вычитание занизило бы расходы. Незнакомый тип расхода, наоборот,
учитывается как трата (деньги с карты ушли) и тоже называется в сводке.
"""
from __future__ import annotations

import json
import os
import traceback
from collections.abc import Mapping
from datetime import date, datetime, timedelta, timezone
from typing import NamedTuple

import asyncpg
import httpx

from .base import SyncSource
from ._bank_common import coerce_amount

API_BASE = "https://private.mybrocard.com"
CARDS_URL = f"{API_BASE}/api/v2/cards"
PAYMENTS_URL = f"{API_BASE}/api/v2/payments"
BALANCE_HISTORY_URL = f"{API_BASE}/api/v2/balance/history"

#: Ключ один на весь аккаунт. Значение в репозиторий не кладём.
API_KEY_ENV = "BROCARD_API_KEY"

#: Карта отбирается по названию, а не по id: id живой карты (2660444) не
#: вечен — владелец может перевыпустить её или завести вторую с тем же
#: названием, и тогда синк должен подхватить обе, а не одну зашитую.
CARD_TITLE_ENV = "BROCARD_CARD_TITLE"
DEFAULT_CARD_TITLE = "ХОНГ Покупки"

#: Начало запрашиваемого периода.
#:
#: Без явного диапазона Brocard отдаёт только недавнее, и делает это молча:
#: `/payments` без `dates[]` вернул 252 платежа вместо 2328 за всю историю.
#: На первом прогоне это стоило четверти движений — их не с чем было связать,
#: поэтому они ушли в `card_unverified`, — и мерчанта у 162 записей из 178.
#:
#: Имя параметра именно `dates[begin]` / `dates[end]`: вариант `date[begin]`
#: принимается без ошибки и молча игнорируется, оставляя окно по умолчанию.
HISTORY_BEGIN = "2020-01-01"

#: Потолок пагинации — API отдаёт до 1000 записей на страницу.
PER_PAGE = 1000
#: Предохранитель от бесконечного цикла, если last_page вдруг поедет.
MAX_PAGES = 200

#: Смещение, которым достраиваются даты без пояса (см. parse_datetime).
MSK_TZ = timezone(timedelta(hours=3))

#: Расходные типы движения баланса — деньги ушли с карты.
EXPENSE_TYPES = frozenset({"payment", "payment_fee", "declined_payment_fee"})
#: Приходные типы, которые гасят ранее учтённую трату, а не добавляют доход.
REFUND_TYPES = frozenset({"payment_void"})


class BrocardCard(NamedTuple):
    """Карта такой, какой её отдал /api/v2/cards."""

    id: str
    title: str
    last_four: str
    currency: str
    state: str


def _bump(counters: dict[str, int] | None, key: str) -> None:
    if counters is not None:
        counters[key] = counters.get(key, 0) + 1


def _breakdown(counters: Mapping[str, int]) -> str:
    return ", ".join(f"{k}={v}" for k, v in sorted(counters.items()))


def api_key(env: Mapping[str, str] | None = None) -> str:
    source = os.environ if env is None else env
    return (source.get(API_KEY_ENV) or "").strip()


def card_title(env: Mapping[str, str] | None = None) -> str:
    """Название нужной карты. Пустое значение переменной = дефолт, а не
    «синкать все карты подряд»: пустой фильтр утянул бы в расходы студии
    покупки по всем чужим картам аккаунта."""
    source = os.environ if env is None else env
    return (source.get(CARD_TITLE_ENV) or "").strip() or DEFAULT_CARD_TITLE


# ── Разбор ответов ────────────────────────────────────────────────────────


def parse_state_label(value: object) -> str:
    """state → человекочитаемая метка.

    Документация Brocard обещает строку, живой API отдаёт объект
    {"value": 2, "label": "Active"} — и у карты, и у платежа. Обрабатываем оба
    вида, чтобы возврат документации к обещанному ничего не сломал.
    """
    if isinstance(value, Mapping):
        label = value.get("label")
        if label not in (None, ""):
            return str(label)
        raw_value = value.get("value")
        return "" if raw_value in (None, "") else str(raw_value)
    return "" if value in (None, "") else str(value)


def page_items(payload: object) -> tuple[list[dict], int | None]:
    """Страница ответа → (записи, номер последней страницы или None).

    None вместо last_page означает «ручка не сказала, сколько страниц» —
    вызывающий тогда идёт по признаку «страница пришла полной», а не
    останавливается на первой (молчаливое обрезание выгрузки было бы
    неотличимо от «операций больше нет»).
    """
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)], 1
    if not isinstance(payload, Mapping):
        return [], 1

    data = payload.get("data")
    items = [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []

    raw_last = payload.get("last_page")
    try:
        last_page: int | None = max(int(raw_last), 1)
    except (TypeError, ValueError):
        last_page = None
    return items, last_page


def parse_cards(payload: list[dict], wanted_title: str) -> list[BrocardCard]:
    """Ответ /api/v2/cards → карты с нужным названием.

    Сравнение точное, но нечувствительное к регистру и обрамляющим пробелам:
    «содержит» подтянуло бы карту «ХОНГ Покупки 2 (личное)» вместе с нужной.
    Несколько карт с одинаковым названием — штатный случай (перевыпуск,
    вторая карта под тот же расход), возвращаются все.

    Запись без id пропускается с логом, а не роняет разбор: одна странная
    карта не должна лишить синк остальных.
    """
    wanted = wanted_title.strip().casefold()
    cards: list[BrocardCard] = []
    seen: set[str] = set()

    for entry in payload:
        title = str(entry.get("title") or "").strip()
        if title.casefold() != wanted:
            continue

        card_id = str(entry.get("id") or "").strip()
        if not card_id:
            print(
                f"[brocard] пропускаю карту без id: {entry!r}",
                flush=True,
            )
            continue
        if card_id in seen:
            continue
        seen.add(card_id)

        cards.append(
            BrocardCard(
                id=card_id,
                title=title,
                last_four=str(entry.get("last_four") or "").strip(),
                currency=str(entry.get("currency") or "").strip().upper(),
                state=parse_state_label(entry.get("state")),
            )
        )
    return cards


def parse_datetime(value: object) -> datetime | None:
    """Дата Brocard → datetime с поясом. None — не разобралась.

    Общий parse_date из _bank_common здесь НЕ годится намеренно: он режет
    строку до 19 символов и штампует UTC, то есть у
    "2026-07-31T09:42:35+03:00" смещение просто отбрасывается. Витрина считает
    дату как (occurred_at AT TIME ZONE 'Europe/Moscow')::date, поэтому такая
    операция уехала бы на три часа назад и вечерние покупки попали бы в
    предыдущий день.

    Два эндпоинта отдают дату по-разному:
      /balance/history — "2026-07-31T09:42:35+03:00" (со смещением);
      /payments        — "2026-07-02 01:10:05"      (без смещения).

    Смещение, если оно есть, сохраняется как пришло. Если его нет — время
    трактуется как московское: тот же аккаунт в /balance/history отдаёт
    +03:00, то есть Brocard показывает владельцу московское время, и витрина
    расходов считает дни тоже по Москве. Трактовать такую дату как UTC значило
    бы сдвинуть операцию на три часа назад — ночная покупка уехала бы на
    предыдущий день.
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    # fromisoformat до 3.11 не понимает "Z"; нормализуем сами, чтобы поведение
    # не зависело от версии рантайма.
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=MSK_TZ)


def period_params() -> dict[str, str]:
    """Диапазон дат для обеих ручек Brocard — см. `HISTORY_BEGIN`."""
    return {"dates[begin]": HISTORY_BEGIN, "dates[end]": date.today().isoformat()}


def index_payments(payments: list[dict]) -> dict[str, dict]:
    """Платежи → индекс по строковому id (id движения приходит числом, а
    based_on_id может прийти и числом, и строкой)."""
    index: dict[str, dict] = {}
    for payment in payments:
        payment_id = payment.get("id")
        if payment_id in (None, ""):
            continue
        index[str(payment_id)] = payment
    return index


def payment_card_id(payment: Mapping) -> str:
    """id карты платежа. Пустая строка — в платеже карты нет."""
    card = payment.get("card")
    if not isinstance(card, Mapping):
        return ""
    return str(card.get("id") or "").strip()


def linked_payment(mv: Mapping, payments_by_id: Mapping[str, dict]) -> dict | None:
    """Движение баланса → связанный платёж, если он есть в индексе.

    based_on_type проверяется до похода в индекс: если Brocard заведёт
    движение, основанное не на платеже (пополнение счёта, перевод), его
    based_on_id будет id совсем другой сущности, и слепой поиск по индексу
    платежей мог бы случайно совпасть по числу и приписать движению чужого
    мерчанта. Пустой based_on_type пропускаем в индекс: сегодня все известные
    типы движения по карте основаны на платеже.
    """
    based_on_type = str(mv.get("based_on_type") or "").strip().casefold()
    if based_on_type and "payment" not in based_on_type:
        return None
    based_on_id = mv.get("based_on_id")
    if based_on_id in (None, ""):
        return None
    return payments_by_id.get(str(based_on_id))


def account_matches_card(mv: Mapping, card: BrocardCard) -> bool:
    """Опознаётся ли карта по полям account/account_number движения.

    Запасной путь для движений, у которых платёж в индексе не нашёлся
    (например, если /payments не отдаёт отклонённые попытки, а комиссия за
    отказ в истории баланса есть). Совпадение по четырём последним цифрам —
    сигнал слабее, чем card.id связанного платежа, и теоретически может
    совпасть у двух карт аккаунта; поэтому он проверяется только после
    сильного и только как разрешение записать строку, но никогда — как
    основание её отбросить.
    """
    for key in ("account", "account_number"):
        raw = mv.get(key)
        if raw in (None, ""):
            continue
        text = str(raw).strip()
        if card.title and text.casefold() == card.title.casefold():
            return True
        digits = "".join(ch for ch in text if ch.isdigit())
        if not digits:
            continue
        if digits == card.id:
            return True
        if card.last_four and digits.endswith(card.last_four):
            return True
    return False


def owner_card(
    mv: Mapping, payment: Mapping | None, cards: list[BrocardCard]
) -> tuple[BrocardCard | None, str]:
    """Кому принадлежит движение баланса: (карта, чем доказано).

    Второй элемент — 'payment' (доказано картой связанного платежа),
    'account' (доказано полями самого движения), 'foreign' (доказано, что
    карта чужая) или 'unknown' (доказать нечем).

    Серверный фильтр по карте на /payments проверен и НЕ работает, поэтому
    ответ /balance/history тоже считается непроверенным: без доказательства
    строка не пишется. Это отбор на нашей стороне, о котором говорит
    докстринг модуля.
    """
    if payment is not None:
        card_id = payment_card_id(payment)
        for card in cards:
            if card.id == card_id:
                return card, "payment"
        return None, "foreign"

    for card in cards:
        if account_matches_card(mv, card):
            return card, "account"
    return None, "unknown"


# ── Маппинг в строку таблицы ──────────────────────────────────────────────

#: Порядок колонок в INSERT источника. Менять только вместе с _upsert().
BROCARD_COLUMNS: tuple[str, ...] = (
    "external_id", "card_id", "card_label", "holder",
    "occurred_at", "amount", "currency", "amount_account", "currency_account",
    "merchant", "merchant_category", "status",
    "direction", "operation_type", "payment_id", "raw",
)


def to_row(d: dict) -> tuple:
    """dict → кортеж в порядке BROCARD_COLUMNS для executemany."""
    return tuple(d[c] for c in BROCARD_COLUMNS)


def map_movement(
    mv: dict,
    payment: dict | None,
    card: BrocardCard,
    skip_counts: dict[str, int] | None = None,
    stats: dict[str, int] | None = None,
) -> dict | None:
    """Движение баланса (+ связанный платёж) → словарь полей
    brocard_transactions. None — пропустить.

    Знак суммы задаётся направлением и типом, а не знаком, который пришёл в
    строке: /balance/history отдаёт "-0.88" у расхода, и записать это число
    как есть значило бы вычитать траты из расходов. Витрина expenses_v просто
    складывает amount, поэтому трата кладётся положительной, а возврат
    (payment_void) — отрицательной: так он гасит ранее учтённую трату и не
    превращается в доход. Исходное направление сохраняется отдельной колонкой
    direction, тип операции — колонкой operation_type.

    Незнакомый тип прихода пропускается (skip_counts), а не вычитается:
    появись у Brocard пополнение карты, слепое вычитание занизило бы расходы.
    Незнакомый тип расхода записывается как трата — деньги с карты ушли, — но
    называется в stats, чтобы человек увидел новый тип и решил осознанно.

    Непригодная запись (нет id, не разобралась дата/сумма/валюта)
    пропускается с логом, а не роняет батч.
    """
    tx_id = mv.get("transaction_id")
    if tx_id in (None, ""):
        print(f"[brocard] skip: движение без transaction_id: {mv!r}", flush=True)
        _bump(skip_counts, "no_transaction_id")
        return None

    op_type = str(mv.get("type") or "").strip().casefold()
    direction = str(mv.get("direction") or "").strip().casefold()
    _bump(stats, f"type:{op_type or '<missing>'}")

    occurred_at = parse_datetime(mv.get("date"))
    if occurred_at is None:
        print(
            f"[brocard] skip transaction_id={tx_id!r}: не разобралась дата "
            f"date={mv.get('date')!r}",
            flush=True,
        )
        _bump(skip_counts, "bad_date")
        return None

    magnitude = coerce_amount(mv.get("amount"))
    if magnitude is None:
        print(
            f"[brocard] skip transaction_id={tx_id!r}: не разобралась сумма "
            f"amount={mv.get('amount')!r}",
            flush=True,
        )
        _bump(skip_counts, "bad_amount")
        return None
    magnitude = abs(magnitude)

    if direction == "outcome":
        amount = magnitude
        if op_type not in EXPENSE_TYPES:
            print(
                f"[brocard] transaction_id={tx_id!r}: незнакомый тип расхода "
                f"{op_type!r} — записан как трата (деньги с карты ушли), "
                f"проверьте, так ли это",
                flush=True,
            )
            _bump(stats, f"unknown_outcome_type:{op_type or '<missing>'}")
    elif direction == "income":
        if op_type not in REFUND_TYPES:
            print(
                f"[brocard] skip transaction_id={tx_id!r}: незнакомый тип "
                f"прихода {op_type!r} — НЕ вычитаем вслепую. Если это возврат, "
                f"добавьте тип в REFUND_TYPES; если пополнение карты — "
                f"вычитание занизило бы расходы",
                flush=True,
            )
            _bump(skip_counts, f"unknown_income_type:{op_type or '<missing>'}")
            return None
        amount = -magnitude
    else:
        print(
            f"[brocard] skip transaction_id={tx_id!r}: неизвестное направление "
            f"{mv.get('direction')!r}",
            flush=True,
        )
        _bump(skip_counts, f"unknown_direction:{direction or '<missing>'}")
        return None

    # Валюта приходит в нижнем регистре ("usd"), а курс в fx_rates ищется по
    # "USD" — без приведения к верхнему регистру рублёвая сумма в витрине
    # осталась бы пустой навсегда.
    currency = str(mv.get("currency") or "").strip().upper() or card.currency
    if not currency:
        print(
            f"[brocard] skip transaction_id={tx_id!r}: не разобралась валюта "
            f"currency={mv.get('currency')!r}",
            flush=True,
        )
        _bump(skip_counts, "bad_currency")
        return None

    merchant = payment.get("merchant") if payment is not None else None
    merchant = merchant if isinstance(merchant, Mapping) else {}
    user = payment.get("user") if payment is not None else None
    user = user if isinstance(user, Mapping) else {}

    # `name` заполнен только для мерчантов из собственного справочника Brocard
    # (там же непустой `merchant.id`) — на живой карте это 22 записи из 232:
    # LinkedIn, Google, Facebook, Supabase. У остальных `id` и `name` пустые, а
    # настоящее имя лежит в сырой строке эквайера: «INSTANTLY SHERIDAN USA»,
    # «UNIPILE.COM RIORGES FRA», «ZAPMAIL.AI WILMINGTON USA».
    #
    # Берём её как есть, не вычищая город и страну: где кончается название и
    # начинается адрес — угадывание, а правила разметки и так ищут вхождение,
    # так что одно правило «содержит INSTANTLY» закроет все такие строки.
    merchant_name = str(merchant.get("name") or "").strip()
    merchant_source = "name"
    if not merchant_name:
        merchant_name = str(merchant.get("descriptor") or "").strip()
        merchant_source = "descriptor"
    if not merchant_name:
        _bump(stats, "no_merchant")
    else:
        _bump(stats, f"merchant_from_{merchant_source}")

    based_on_id = mv.get("based_on_id")

    return {
        "external_id": str(tx_id),
        "card_id": card.id,
        "card_label": card.title or None,
        "holder": str(user.get("name") or "").strip() or None,
        "occurred_at": occurred_at,
        "amount": amount,
        "currency": currency,
        # Движение по балансу и есть списание со счёта — дублировать ту же
        # сумму во вторую пару колонок нечем и незачем. Исходная сумма
        # покупки в валюте мерчанта (initial_amount/initial_currency платежа)
        # остаётся в raw.
        "amount_account": None,
        "currency_account": None,
        "merchant": merchant_name or None,
        "merchant_category": str(merchant.get("mcc") or "").strip() or None,
        "status": parse_state_label(payment.get("state")) if payment is not None else None,
        "direction": direction,
        "operation_type": op_type or None,
        "payment_id": str(based_on_id) if based_on_id not in (None, "") else None,
        "raw": json.dumps(
            {"movement": mv, "payment": payment}, ensure_ascii=False, default=str
        ),
    }


# ── Сеть ──────────────────────────────────────────────────────────────────


async def fetch_all_pages(
    client: httpx.AsyncClient,
    url: str,
    params: dict | None = None,
    label: str = "",
) -> list[dict]:
    """Все страницы одной ручки Brocard.

    Пагинация реализована честно, а не «первой страницей»: на живой карте за
    полтора года 232 операции, то есть даже при per_page=100 это три
    страницы, и остановка на первой тихо потеряла бы две трети расходов.

    Останов — по last_page из ответа. Если ручка его не прислала, идём, пока
    страница приходит полной: считать «поля нет → страница одна» значило бы
    обрезать выгрузку молча.
    """
    collected: list[dict] = []
    page = 1
    while page <= MAX_PAGES:
        query = dict(params or {})
        query.update({"per_page": PER_PAGE, "page": page})
        resp = await client.get(url, params=query)
        resp.raise_for_status()
        items, last_page = page_items(resp.json())
        collected.extend(items)

        if not items:
            break
        if last_page is None:
            if len(items) < PER_PAGE:
                break
        elif page >= last_page:
            break
        page += 1
    else:
        print(
            f"[brocard] {label or url}: достигнут предел {MAX_PAGES} страниц — "
            f"выгрузка может быть неполной",
            flush=True,
        )
    return collected


class BrocardSync(SyncSource):
    name = "brocard"

    async def run(self, conn: asyncpg.Connection) -> int:
        key = api_key()
        if not key:
            raise NotImplementedError("BROCARD_API_KEY не задан")

        wanted_title = card_title()
        headers = {"Authorization": f"Bearer {key}", "Accept": "application/json"}
        total = 0
        skip_counts: dict[str, int] = {}
        stats: dict[str, int] = {}

        async with httpx.AsyncClient(timeout=90, headers=headers) as client:
            cards_payload = await fetch_all_pages(client, CARDS_URL, label="cards")
            cards = parse_cards(cards_payload, wanted_title)
            if not cards:
                # Название карты — конфиг, который человек может опечатать.
                # Возвращаем в ошибке список того, что реально есть, чтобы
                # опечатка чинилась с первого раза, а не по логам API.
                available = sorted(
                    {
                        str(c.get("title") or "").strip()
                        for c in cards_payload
                        if str(c.get("title") or "").strip()
                    }
                )
                raise RuntimeError(
                    f"карта с названием {wanted_title!r} не найдена "
                    f"({CARD_TITLE_ENV}). Доступные названия: "
                    + (", ".join(repr(t) for t in available) or "<ни одной>")
                )

            print(
                f"[brocard] карт по названию {wanted_title!r}: {len(cards)} — "
                + ", ".join(
                    f"id={c.id} last_four={c.last_four or '?'} "
                    f"{c.currency or '?'} state={c.state or '?'}"
                    for c in cards
                ),
                flush=True,
            )

            # Платежи читаются целиком и без фильтра по карте: серверный
            # фильтр проверен и не работает, а полный индекс нужен ещё и
            # затем, чтобы опознавать чужие карты (см. owner_card).
            #
            # Диапазон дат обязателен: без него ручка отдаёт только недавнее
            # и молча (см. HISTORY_BEGIN).
            payments = await fetch_all_pages(
                client, PAYMENTS_URL, period_params(), label="payments"
            )
            payments_by_id = index_payments(payments)
            print(
                f"[brocard] платежей в аккаунте: {len(payments_by_id)}",
                flush=True,
            )

            seen_ids: set[str] = set()
            for card in cards:
                # Изоляция карты: сбой одной (сеть, битый ответ, ошибка
                # upsert) не должен унести остальные — источник обязан дойти
                # до конца и залить то, что удалось.
                try:
                    total += await self._sync_card(
                        conn, client, card, cards, payments_by_id,
                        seen_ids, skip_counts, stats,
                    )
                except Exception as e:
                    print(
                        f"[brocard] card FAIL id={card.id} {card.title!r}: "
                        f"{e}\n{traceback.format_exc()}",
                        flush=True,
                    )

        self._print_summary(total, skip_counts, stats)
        return total

    async def _sync_card(
        self,
        conn: asyncpg.Connection,
        client: httpx.AsyncClient,
        card: BrocardCard,
        cards: list[BrocardCard],
        payments_by_id: dict[str, dict],
        seen_ids: set[str],
        skip_counts: dict[str, int],
        stats: dict[str, int],
    ) -> int:
        """Все движения баланса одной карты. Возвращает число залитых строк."""
        movements = await fetch_all_pages(
            client,
            BALANCE_HISTORY_URL,
            {"card": card.id, **period_params()},
            label=f"balance/history card={card.id}",
        )

        mapped_rows: list[dict] = []
        foreign = 0
        for mv in movements:
            tx_id = str(mv.get("transaction_id") or "")
            if tx_id:
                if tx_id in seen_ids:
                    # Тот же ответ пришёл на запрос другой карты — верный
                    # признак, что серверный фильтр игнорируется. Помечаем
                    # движение увиденным ДО проверки принадлежности, чтобы
                    # каждое движение попало ровно в один счётчик.
                    _bump(skip_counts, "duplicate_movement")
                    continue
                seen_ids.add(tx_id)

            payment = linked_payment(mv, payments_by_id)
            owner, proof = owner_card(mv, payment, cards)
            if owner is None:
                if proof == "foreign":
                    foreign += 1
                    _bump(skip_counts, "foreign_card")
                else:
                    # Ни платежа в индексе, ни совпадения по account/
                    # account_number: доказать принадлежность нечем. Не пишем
                    # и громко считаем — молча записанная чужая трата портит
                    # суммы дашборда неотличимо от правды, а громкий пропуск
                    # виден в сводке прогона и чинится осознанно.
                    _bump(
                        skip_counts,
                        f"card_unverified:{str(mv.get('type') or '<missing>').casefold()}",
                    )
                continue

            _bump(stats, f"linked_by_{proof}")
            mapped = map_movement(mv, payment, owner, skip_counts, stats)
            if mapped is not None:
                mapped_rows.append(mapped)

        # Ответ на вопрос «работает ли серверный фильтр card=» — из живого
        # прогона, а не из чьей-то памяти.
        if movements:
            if foreign:
                print(
                    f"[brocard] card={card.id}: серверный фильтр card= НЕ "
                    f"работает — {foreign} из {len(movements)} строк ответа "
                    f"принадлежат другим картам, отбор идёт на нашей стороне",
                    flush=True,
                )
            else:
                print(
                    f"[brocard] card={card.id}: в ответе {len(movements)} "
                    f"строк, чужих карт среди них не обнаружено",
                    flush=True,
                )

        if mapped_rows:
            await self._upsert(conn, [to_row(m) for m in mapped_rows])
        return len(mapped_rows)

    @staticmethod
    def _print_summary(
        total: int, skip_counts: dict[str, int], stats: dict[str, int]
    ) -> None:
        print(f"[brocard] записей к заливке: {total}", flush=True)
        if stats:
            print(f"[brocard] разбивка: {_breakdown(stats)}", flush=True)
        if skip_counts:
            print(
                f"[brocard] пропущено {sum(skip_counts.values())} движение(й): "
                f"{_breakdown(skip_counts)}",
                flush=True,
            )
        unknown_income = {
            k: v for k, v in skip_counts.items() if k.startswith("unknown_income_type:")
        }
        if unknown_income:
            print(
                f"[brocard] ВНИМАНИЕ: незнакомые типы прихода не учтены "
                f"({_breakdown(unknown_income)}). Если это возврат — добавьте "
                f"тип в REFUND_TYPES; если пополнение — так и должно быть",
                flush=True,
            )

    async def _upsert(self, conn: asyncpg.Connection, rows: list[tuple]) -> None:
        await conn.executemany(
            """INSERT INTO brocard_transactions (
                 external_id, card_id, card_label, holder,
                 occurred_at, amount, currency, amount_account, currency_account,
                 merchant, merchant_category, status,
                 direction, operation_type, payment_id, raw
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
               ON CONFLICT (external_id) DO UPDATE SET
                 card_id           = EXCLUDED.card_id,
                 card_label        = EXCLUDED.card_label,
                 holder            = EXCLUDED.holder,
                 occurred_at       = EXCLUDED.occurred_at,
                 amount            = EXCLUDED.amount,
                 currency          = EXCLUDED.currency,
                 merchant          = EXCLUDED.merchant,
                 merchant_category = EXCLUDED.merchant_category,
                 status            = EXCLUDED.status,
                 direction         = EXCLUDED.direction,
                 operation_type    = EXCLUDED.operation_type,
                 payment_id        = EXCLUDED.payment_id,
                 raw               = EXCLUDED.raw,
                 synced_at         = now()""",
            rows,
        )
