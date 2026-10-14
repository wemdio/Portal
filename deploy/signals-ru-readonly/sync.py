#!/usr/bin/env python3
"""Копирует wizard_sessions_ru, wizard_jobs_ru, users_ru из SQLite Signals RU
в read-only Postgres (контейнер signals-ru-readonly).

Рабочий файл открывается только на чтение (mode=ro) и копируется в память
через backup API за одно движение — блокировка чтения длится доли секунды.
Таблицы в Postgres пересоздаются целиком в одной транзакции: при любой
ошибке остаётся предыдущая версия.

Только stdlib; запускается на хосте из cron (см. signals-ru-readonly.cron).
"""
import csv
import datetime as dt
import json
import os
import sqlite3
import subprocess
import sys
import time

SOURCE = "/var/lib/docker/volumes/outreachos-signals-ru_outreachos-ru-data/_data/signals_ru.db"
INCOMING = "/var/lib/signals-ru-readonly/incoming"  # смонтирован в контейнер как /incoming:ro
CONTAINER = "signals-ru-readonly"
DATABASE = "signals_ru"
READER_ROLE = "signals_ro"
TABLES = ["users_ru", "wizard_sessions_ru", "wizard_jobs_ru"]

# Текстовые колонки с JSON внутри — кладём как jsonb, если все значения валидны.
JSON_COLUMNS = {"detected_icp"}
# Колонки с датами — timestamptz (наивное время считается UTC), если все значения разбираются.
TIME_SUFFIXES = ("_at", "_until")


def log(msg):
    print(f"{dt.datetime.now(dt.timezone.utc):%Y-%m-%d %H:%M:%S}Z {msg}", flush=True)


def qi(name):
    return '"' + name.replace('"', '""') + '"'


def clean_text(v):
    return v.replace("\x00", "")


def as_json(v):
    def reject(c):
        raise ValueError(c)
    if "\\u0000" in v:  # jsonb не принимает \u0000
        raise ValueError("nul")
    json.loads(v, parse_constant=reject)
    return v


def as_time(v):
    t = dt.datetime.fromisoformat(v)
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return t.isoformat()


def plan_column(name, decl, values):
    """Возвращает (pg_type, converter). При несовпадении значений — text."""
    decl = (decl or "").upper()
    present = [v for v in values if v is not None]
    if "INT" in decl and all(isinstance(v, int) for v in present):
        return "bigint", None
    if ("REAL" in decl or "FLOA" in decl or "DOUB" in decl) and all(isinstance(v, (int, float)) for v in present):
        return "double precision", None
    candidates = []
    if name.endswith("_json") or name in JSON_COLUMNS:
        candidates.append(("jsonb", as_json))
    if name.endswith(TIME_SUFFIXES):
        candidates.append(("timestamptz", as_time))
    for pg_type, conv in candidates:
        try:
            for v in present:
                if not isinstance(v, str):
                    raise ValueError(type(v))
                conv(clean_text(v))
            return pg_type, conv
        except ValueError:
            log(f"  {name}: не все значения подходят под {pg_type}, оставляю text")
    return "text", None


def to_cell(v, conv):
    if v is None:
        return None
    if isinstance(v, bytes):
        return "\\x" + v.hex()
    if isinstance(v, str):
        v = clean_text(v)
        return conv(v) if conv else v
    return v


def export_table(mem, table):
    info = mem.execute(f"pragma table_info({qi(table)})").fetchall()
    cols = [(r[1], r[2], r[5]) for r in info]  # name, decl type, pk position
    rows = mem.execute(f"select * from {qi(table)}").fetchall()
    plans = [plan_column(name, decl, [r[i] for r in rows]) for i, (name, decl, _) in enumerate(cols)]

    path = os.path.join(INCOMING, f"{table}.csv")
    with open(path + ".tmp", "w", newline="", encoding="utf-8") as f:
        # QUOTE_NOTNULL: None -> пусто без кавычек (NULL в COPY), '' -> "" (пустая строка)
        w = csv.writer(f, quoting=csv.QUOTE_NOTNULL)
        w.writerow([c[0] for c in cols])
        for r in rows:
            w.writerow([to_cell(v, plan[1]) for v, plan in zip(r, plans)])
    os.chmod(path + ".tmp", 0o644)
    os.replace(path + ".tmp", path)

    col_sql = ",\n  ".join(f"{qi(name)} {plan[0]}" for (name, _, _), plan in zip(cols, plans))
    pk = [name for name, _, pos in sorted(cols, key=lambda c: c[2]) if pos > 0]
    if pk:
        # SQLite допускает NULL и (при кривых данных) дубли в TEXT PRIMARY KEY — тогда без ключа, но без падения.
        idx = [i for i, c in enumerate(cols) if c[0] in pk]
        keys = [tuple(r[i] for i in idx) for r in rows]
        if any(v is None for k in keys for v in k) or len(set(keys)) != len(keys):
            log(f"  {table}: первичный ключ не уникален или содержит NULL, создаю без PRIMARY KEY")
            pk = []
    sql = [
        f"DROP TABLE IF EXISTS public.{qi(table)};",
        f"CREATE TABLE public.{qi(table)} (\n  {col_sql}\n);",
        f"COPY public.{qi(table)} FROM '/incoming/{table}.csv' WITH (FORMAT csv, HEADER true);",
    ]
    if pk:
        sql.append(f"ALTER TABLE public.{qi(table)} ADD PRIMARY KEY ({', '.join(qi(c) for c in pk)});")
    sql += [
        f"COMMENT ON TABLE public.{qi(table)} IS 'Копия {table} из SQLite Signals RU, только чтение; обновляется каждые 15 минут, время обновления — в _sync_info';",
        f"GRANT SELECT ON public.{qi(table)} TO {READER_ROLE};",
    ]
    return "\n".join(sql), len(rows)


def main():
    started = time.monotonic()
    src = sqlite3.connect(f"file:{SOURCE}?mode=ro", uri=True, timeout=30)
    mem = sqlite3.connect(":memory:")
    src.backup(mem)
    src.close()
    snapshot_at = dt.datetime.now(dt.timezone.utc)

    parts, counts = [], {}
    for t in TABLES:
        sql, n = export_table(mem, t)
        parts.append(sql)
        counts[t] = n
    mem.close()

    counts_json = json.dumps(counts).replace("'", "''")
    script = "\n".join([
        "\\set ON_ERROR_STOP on",
        "SET lock_timeout = '60s';",
        "SET TimeZone = 'UTC';",
        "BEGIN;",
        *parts,
        "DROP TABLE IF EXISTS public._sync_info;",
        "CREATE TABLE public._sync_info (synced_at timestamptz NOT NULL, source_snapshot_at timestamptz NOT NULL, row_counts jsonb NOT NULL);",
        f"INSERT INTO public._sync_info VALUES (now(), '{snapshot_at.isoformat()}', '{counts_json}');",
        "COMMENT ON TABLE public._sync_info IS 'Когда была последняя успешная синхронизация';",
        f"GRANT SELECT ON public._sync_info TO {READER_ROLE};",
        "COMMIT;",
    ])
    proc = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", DATABASE, "-q", "-X"],
        input=script, text=True, capture_output=True, timeout=600,
    )
    for t in TABLES:
        try:
            os.remove(os.path.join(INCOMING, f"{t}.csv"))
        except FileNotFoundError:
            pass
    if proc.returncode != 0:
        log(f"FAIL psql rc={proc.returncode}: {proc.stderr.strip()[-2000:]}")
        sys.exit(1)
    log(f"ok {counts} за {time.monotonic() - started:.1f}s")


if __name__ == "__main__":
    main()
