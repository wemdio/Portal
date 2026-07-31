from __future__ import annotations

import asyncio
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


MODULE_PATH = Path(__file__).with_name("main.py")
SPEC = importlib.util.spec_from_file_location("portal_health_check_main", MODULE_PATH)
assert SPEC and SPEC.loader
health = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = health
SPEC.loader.exec_module(health)


class FakeConnection:
    def __init__(self, rows=None):
        self.rows = rows or []
        self.fetch = AsyncMock(return_value=self.rows)
        self.fetchrow = AsyncMock(return_value={"alert_key": "claimed"})
        self.fetchval = AsyncMock(return_value=1)
        self.execute = AsyncMock()
        self.executemany = AsyncMock()
        self.close = AsyncMock()


class JobMonitorTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        health.DATABASE_URL = "postgres://test"
        health._JOB_PROGRESS_TRACKER.clear()

    def test_manual_stop_messages_are_not_failures(self):
        self.assertTrue(health._is_manual_stop_error("Остановлено пользователем"))
        self.assertTrue(health._is_manual_stop_error("Job cancelled by user"))
        self.assertFalse(health._is_manual_stop_error("Playwright browser crashed"))

    async def test_stuck_pending_job_alerts_once(self):
        spec = health.JobMonitorSpec(
            "yandex_maps_jobs",
            "Яндекс.Карты",
            ("pending", "running"),
            ("processed_links",),
            "portal-worker-yandexmaps",
        )
        row = {
            "id": "12345678-aaaa-bbbb-cccc-123456789000",
            "status": "pending",
            "progress": "0",
            "activity_secs": None,
            "active_secs": 901,
            "age_secs": 901,
            "owner_name": "Ксения Хохлова",
            "owner_email": "x@example.com",
        }
        conn = FakeConnection()
        with (
            patch.object(health, "_JOB_MONITOR_SPECS", (spec,)),
            patch.object(health.asyncpg, "connect", AsyncMock(return_value=conn)),
            patch.object(health, "_fetch_active_job_rows", AsyncMock(return_value=[row])),
            patch.object(health, "_claim_job_alert", AsyncMock(side_effect=[True, False])),
        ):
            first = await health.check_stuck_jobs()
            second = await health.check_stuck_jobs()

        self.assertEqual(len(first), 1)
        self.assertIn("Долго висит: Яндекс.Карты", first[0])
        self.assertIn("Ксения Хохлова", first[0])
        self.assertEqual(second, [])

    async def test_failed_job_skips_manual_stop_and_alerts_real_error(self):
        spec = health.JobMonitorSpec(
            "yandex_maps_jobs",
            "Яндекс.Карты",
            ("pending", "running"),
            ("processed_links",),
            "portal-worker-yandexmaps",
        )
        rows = [
            {
                "id": "manual-stop",
                "status": "failed",
                "error_message": "Остановлено пользователем",
                "owner_name": "Коллега",
                "owner_email": None,
            },
            {
                "id": "real-error",
                "status": "failed",
                "error_message": "Playwright browser crashed",
                "owner_name": "Коллега",
                "owner_email": None,
            },
        ]
        conn = FakeConnection(rows=rows)
        claim = AsyncMock(return_value=True)
        with (
            patch.object(health, "_JOB_MONITOR_SPECS", (spec,)),
            patch.object(health.asyncpg, "connect", AsyncMock(return_value=conn)),
            patch.object(health, "_baseline_existing_failures", AsyncMock(return_value=True)),
            patch.object(health, "_claim_job_alert", claim),
        ):
            alerts = await health.check_failed_jobs()

        self.assertEqual(len(alerts), 1)
        self.assertIn("Playwright browser crashed", alerts[0])
        claim.assert_awaited_once_with(conn, "failed:yandex_maps_jobs:real-error")


if __name__ == "__main__":
    unittest.main()
