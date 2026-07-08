"""DB helpers: логирование прогонов синка в external_sync_runs."""
from __future__ import annotations

import json
from typing import Any, Optional

import asyncpg


async def log_run_start(conn: asyncpg.Connection, source: str) -> int:
    row = await conn.fetchrow(
        """INSERT INTO external_sync_runs (source, status)
           VALUES ($1, 'running')
           RETURNING id""",
        source,
    )
    return int(row["id"])


async def log_run_finish(
    conn: asyncpg.Connection,
    run_id: int,
    status: str,
    records: Optional[int] = None,
    error: Optional[str] = None,
    meta: Optional[dict[str, Any]] = None,
) -> None:
    await conn.execute(
        """UPDATE external_sync_runs
           SET finished_at = now(),
               status = $2,
               records_upserted = $3,
               error = $4,
               meta = $5::jsonb
           WHERE id = $1""",
        run_id,
        status,
        records,
        (error[:4000] if error else None),
        (json.dumps(meta) if meta else None),
    )
