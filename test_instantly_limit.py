import asyncio
import httpx
import os

API_KEY = "NDYyZDQ0N2MtYzQzZC00NjdhLTk0NWEtM2MxNDJlN2I5ZGY5Old4QUFZUlhJcEF4Sg=="

async def test_limits():
    async with httpx.AsyncClient() as client:
        r = await client.get("https://api.instantly.ai/api/v2/campaigns", headers={"Authorization": f"Bearer {API_KEY}"})
        items = r.json().get("items", [])
        campaign_id = items[0]["id"]
        for limit in [100, 200, 500]:
            r = await client.post(
                "https://api.instantly.ai/api/v2/leads/list",
                json={"campaign_id": campaign_id, "limit": limit},
                headers={"Authorization": f"Bearer {API_KEY}"}
            )
            print(f"limit={limit} -> {r.status_code} {str(r.text)[:100]}")

asyncio.run(test_limits())
