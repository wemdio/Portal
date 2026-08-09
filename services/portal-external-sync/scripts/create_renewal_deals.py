# Backfill of renewal deals into the AMO pipeline "Vtorichnye (i ne tolko) prodazhi".
#
# One-off migration, not a scheduled source. It reads portal projects of type
# "Prodlenie" and creates one deal per project in the renewals pipeline at the
# "Prodleno" stage, because those renewals have already happened.
#
# Idempotency is the whole point of this script. Creating deals in a CRM cannot
# be undone with a rollback, and a second run would silently double every card.
# So every created deal is written into attribution_amo_project with
# method='renewal_backfill', and projects already present there are skipped.
# That table is also the portal-to-AMO link the rest of the codebase lacks, so
# the backfill leaves something useful behind even beyond the cards themselves.
#
# Default mode is a dry run: it prints exactly what would be created and exits
# without touching AMO. Pass --apply to actually create.
#
# ASCII only on purpose: the file is piped through a console, and non-ASCII
# would depend on the code page of whatever shell forwards it.

import argparse
import asyncio
import json
import os
import re
from datetime import datetime, timezone, timedelta

import asyncpg
import httpx

PIPELINE_ID = int(os.environ.get("RENEWALS_PIPELINE_ID", "11176862"))
STATUS_RENEWED = int(os.environ.get("RENEWALS_STATUS_RENEWED", "87712818"))

BASE_URL = os.environ.get("AMO_BASE_URL", "").rstrip("/")
TOKEN = os.environ.get("AMO_ACCESS_TOKEN") or os.environ.get("AMOCRM_TOKEN", "")

MSK = timezone(timedelta(hours=3))

# AMO refuses the whole batch if one entry is malformed, so batches stay small:
# a rejected batch of 10 is easier to read than a rejected batch of 50.
BATCH = 10

# Custom fields we can fill from portal data. Everything else stays empty for a
# human: guessing values into a CRM is worse than leaving a blank.
FIELD_SUM = "Summa prodleniya, R"      # matched loosely, see match_field
FIELD_PAID_AT = "Data oplaty prodleniya"
FIELD_ARTICLE = "Statya finplana"
FIELD_KIND = "Tip vtorichnoy sdelki"

# Loose matching: field names in AMO carry punctuation and case we cannot
# reproduce blindly from an ASCII source file, so we compare on letters only.
FIELD_PATTERNS = {
    "sum": re.compile(r"сумма.*продлен", re.I),
    "paid_at": re.compile(r"дата.*оплат.*продлен", re.I),
    "article": re.compile(r"статья.*финплан", re.I),
    "kind": re.compile(r"тип.*вторичн", re.I),
}


def parse_amount(raw):
    """Portal stores budget as free text: '159 000', '159000 r', '159,000'."""
    if raw is None:
        return None
    digits = re.sub(r"[^\d]", "", str(raw))
    return int(digits) if digits else None


def parse_date_ts(raw):
    """'YYYY-MM-DD' -> unix seconds at MSK midnight. AMO date fields take unix."""
    if not raw:
        return None
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", str(raw).strip())
    if not m:
        return None
    y, mo, d = (int(x) for x in m.groups())
    try:
        return int(datetime(y, mo, d, tzinfo=MSK).timestamp())
    except ValueError:
        return None


async def fetch_fields(client):
    """field name -> {id, type, enums: {lowercased value -> enum_id}}."""
    out = {}
    page = 1
    while page <= 20:
        r = await client.get(
            f"{BASE_URL}/api/v4/leads/custom_fields",
            params={"limit": 250, "page": page},
        )
        if r.status_code == 204:
            break
        r.raise_for_status()
        items = r.json().get("_embedded", {}).get("custom_fields", [])
        if not items:
            break
        for f in items:
            enums = {}
            for e in (f.get("enums") or []):
                if e.get("value") is not None:
                    enums[str(e["value"]).strip().lower()] = e.get("id")
            out[f.get("name") or ""] = {
                "id": f.get("id"),
                "type": f.get("type"),
                "enums": enums,
            }
        page += 1
    return out


def match_field(fields, key):
    pattern = FIELD_PATTERNS[key]
    for name, meta in fields.items():
        if pattern.search(name):
            return name, meta
    return None, None


def build_value(meta, value):
    """Wrap a value the way AMO expects for this field type.

    Select fields take enum_id, not text: sending a plain string silently drops
    the value or rejects the deal. If the option does not exist, we return None
    and the caller leaves the field empty rather than inventing an option.
    """
    ftype = meta.get("type")
    if ftype in ("select", "radiobutton"):
        enum_id = meta["enums"].get(str(value).strip().lower())
        if enum_id is None:
            return None
        return [{"enum_id": enum_id}]
    return [{"value": value}]


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="actually create deals in AMO")
    ap.add_argument("--limit", type=int, default=0, help="cap the number of projects")
    args = ap.parse_args()

    dsn = os.environ.get("SUPABASE_DB_URL") or os.environ.get("DATABASE_URL")
    if not dsn:
        raise SystemExit("SUPABASE_DB_URL / DATABASE_URL is not set")
    if not BASE_URL or not TOKEN:
        raise SystemExit("AMO_BASE_URL / AMO_ACCESS_TOKEN is not set")

    conn = await asyncpg.connect(dsn)
    try:
        rows = await conn.fetch(
            """
            select p.id, p.client, p.name, p.budget, p.payment_date
            from public.projects p
            where p.project_type ilike '%продлен%'
              and not exists (
                select 1 from public.attribution_amo_project a
                where a.project_id = p.id and a.method = 'renewal_backfill'
              )
            order by p.payment_date nulls last
            """
        )
        if args.limit:
            rows = rows[: args.limit]

        print(f"[backfill] projects to create: {len(rows)}", flush=True)
        if not rows:
            print("[backfill] nothing to do - everything is already linked", flush=True)
            return

        headers = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=60, headers=headers) as client:
            fields = await fetch_fields(client)
            resolved = {}
            for key in FIELD_PATTERNS:
                name, meta = match_field(fields, key)
                resolved[key] = meta
                print(f"[backfill] field {key}: {'FOUND ' + str(meta['id']) if meta else 'NOT FOUND - will stay empty'}",
                      flush=True)

            payloads = []
            for row in rows:
                client_name = (row["client"] or row["name"] or "").strip() or "Bez nazvaniya"
                amount = parse_amount(row["budget"])
                paid_ts = parse_date_ts(row["payment_date"])

                cf = []
                if resolved["sum"] and amount is not None:
                    v = build_value(resolved["sum"], amount)
                    if v:
                        cf.append({"field_id": resolved["sum"]["id"], "values": v})
                if resolved["paid_at"] and paid_ts is not None:
                    v = build_value(resolved["paid_at"], paid_ts)
                    if v:
                        cf.append({"field_id": resolved["paid_at"]["id"], "values": v})
                for key, text in (("article", "продления"), ("kind", "продление")):
                    if resolved[key]:
                        v = build_value(resolved[key], text)
                        if v:
                            cf.append({"field_id": resolved[key]["id"], "values": v})

                deal = {
                    "name": f"Продление — {client_name}",
                    "pipeline_id": PIPELINE_ID,
                    "status_id": STATUS_RENEWED,
                }
                if amount is not None:
                    deal["price"] = amount
                if cf:
                    deal["custom_fields_values"] = cf
                payloads.append((row["id"], deal))

            if not args.apply:
                print("[backfill] DRY RUN - nothing will be created. Sample of 3:", flush=True)
                for _pid, deal in payloads[:3]:
                    print("  " + json.dumps(deal, ensure_ascii=False), flush=True)
                print(f"[backfill] would create {len(payloads)} deals. Re-run with --apply", flush=True)
                return

            created = 0
            for i in range(0, len(payloads), BATCH):
                chunk = payloads[i : i + BATCH]
                r = await client.post(
                    f"{BASE_URL}/api/v4/leads",
                    json=[deal for _pid, deal in chunk],
                )
                if r.status_code >= 300:
                    print(f"[backfill] BATCH FAILED {r.status_code}: {r.text[:500]}", flush=True)
                    break
                made = r.json().get("_embedded", {}).get("leads", [])
                # AMO returns created deals in request order, so we can zip them
                # back onto the projects that produced them.
                for (project_id, _deal), lead in zip(chunk, made):
                    await conn.execute(
                        """
                        insert into public.attribution_amo_project
                          (amo_deal_id, project_id, confidence, method, matched_at)
                        values ($1, $2, 1.0, 'renewal_backfill', now())
                        on conflict (amo_deal_id, project_id) do nothing
                        """,
                        int(lead["id"]),
                        project_id,
                    )
                    created += 1
                print(f"[backfill] created {created}/{len(payloads)}", flush=True)

            print(f"[backfill] done - created {created}", flush=True)
    finally:
        await conn.close()


asyncio.run(main())
