"""No browsers/network: verify queue/startup timeout and disconnect cleanup."""
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import server


class ParseLifecycleTests(unittest.IsolatedAsyncioTestCase):
  async def asyncSetUp(self):
    self.parser = SimpleNamespace(
      start=AsyncMock(), parse_organizations_from_links=AsyncMock(return_value=[]),
      close=AsyncMock(), stop=Mock(),
    )
    self.factory = patch.object(server, "YandexMapsParser", return_value=self.parser)
    self.factory.start()
    server._PARSE_SEMAPHORE = asyncio.Semaphore(1)
    self.req = server.ParseOrgsRequest(links=["https://yandex.ru/maps/org/test/1/"])
    self.request = SimpleNamespace(is_disconnected=AsyncMock(return_value=False))

  async def asyncTearDown(self):
    tasks = list(server._PARSE_TASKS)
    for task in tasks:
      task.cancel()
    if tasks:
      await asyncio.gather(*tasks, return_exceptions=True)
    self.factory.stop()

  async def test_deadline_includes_wait_for_slot_and_browser_startup(self):
    with patch.object(server, "PARSE_TIMEOUT_SEC", 0.01):
      await server._PARSE_SEMAPHORE.acquire()
      try:
        with self.assertRaises(server.HTTPException) as failed:
          await server.parse_orgs(self.req, self.request)
        self.assertEqual(failed.exception.status_code, 504)
        self.parser.start.assert_not_awaited()
      finally:
        server._PARSE_SEMAPHORE.release()

      async def hung_start():
        await asyncio.Event().wait()
      self.parser.start.side_effect = hung_start
      with self.assertRaises(server.HTTPException) as failed:
        await server.parse_orgs(self.req, self.request)
      self.assertEqual(failed.exception.status_code, 504)
      self.parser.close.assert_awaited_once()
      self.assertFalse(server._PARSE_SEMAPHORE.locked())

  async def test_disconnect_cancels_active_browser_and_releases_slot(self):
    started = asyncio.Event()
    disconnected = asyncio.Event()
    async def parse_forever(_links):
      started.set()
      await asyncio.Event().wait()
    async def wait_disconnect(_request):
      await disconnected.wait()
    self.parser.parse_organizations_from_links.side_effect = parse_forever
    with patch.object(server, "_wait_for_disconnect", side_effect=wait_disconnect):
      running = asyncio.create_task(server.parse_orgs(self.req, self.request))
      await started.wait()
      disconnected.set()
      with self.assertRaises(server.HTTPException) as failed:
        await running
      self.assertEqual(failed.exception.status_code, 499)
      await asyncio.gather(*list(server._PARSE_TASKS), return_exceptions=True)
    self.parser.close.assert_awaited_once()
    self.assertFalse(server._PARSE_SEMAPHORE.locked())

  async def test_client_leaving_queue_does_not_create_a_browser(self):
    await server._PARSE_SEMAPHORE.acquire()
    self.request.is_disconnected.return_value = True
    with self.assertRaises(server.HTTPException) as failed:
      await server.parse_orgs(self.req, self.request)
    self.assertEqual(failed.exception.status_code, 499)
    await asyncio.gather(*list(server._PARSE_TASKS), return_exceptions=True)
    self.parser.start.assert_not_awaited()
    self.assertTrue(server._PARSE_SEMAPHORE.locked())
    server._PARSE_SEMAPHORE.release()

  async def test_success_and_parser_error_both_close_and_release(self):
    result = await server.parse_orgs(self.req, self.request)
    self.assertEqual(result.organizations, [])
    self.parser.parse_organizations_from_links.side_effect = server.YandexBlockedError("captcha")
    with self.assertRaises(server.HTTPException) as failed:
      await server.parse_orgs(self.req, self.request)
    self.assertEqual(failed.exception.status_code, 429)
    self.assertEqual(self.parser.close.await_count, 2)
    self.assertFalse(server._PARSE_SEMAPHORE.locked())


if __name__ == "__main__":
  unittest.main()
