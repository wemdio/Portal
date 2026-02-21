import asyncio
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from yandex_parser import Organization, ProxySettings, YandexMapsParser


app = FastAPI()
YANDEXMAPS_CONCURRENCY = 2
_REQUEST_SEMAPHORE = asyncio.Semaphore(YANDEXMAPS_CONCURRENCY)


class ProxyModel(BaseModel):
  enabled: bool = False
  protocol: Literal["http", "https", "socks5"] = "http"
  host: str = ""
  port: str = ""
  username: str = ""
  password: str = ""


class CollectLinksRequest(BaseModel):
  search_url: str = Field(min_length=1)
  max_results: int = Field(default=5000, ge=1, le=5000)
  headless: bool = True
  proxy: Optional[ProxyModel] = None


class CollectLinksResponse(BaseModel):
  links: list[str]


class ParseOrgsRequest(BaseModel):
  links: list[str] = Field(min_length=1)
  headless: bool = True
  proxy: Optional[ProxyModel] = None


class OrganizationModel(BaseModel):
  name: str = ""
  country: str = ""
  city: str = ""
  address: str = ""
  rating: str = ""
  reviews_count: str = ""
  website: str = ""
  email: str = ""
  phone: str = ""
  telegram: str = ""
  vk: str = ""
  instagram: str = ""
  whatsapp: str = ""
  card_url: str = ""
  working_hours: str = ""
  categories: str = ""


class ParseOrgsResponse(BaseModel):
  organizations: list[OrganizationModel]


def _to_proxy_settings(proxy: Optional[ProxyModel]) -> ProxySettings:
  if not proxy or not proxy.enabled:
    return ProxySettings(enabled=False)
  return ProxySettings(
    enabled=True,
    protocol=proxy.protocol,
    host=proxy.host,
    port=proxy.port,
    username=proxy.username,
    password=proxy.password,
  )


def _org_to_model(org: Organization) -> OrganizationModel:
  return OrganizationModel(
    name=org.name or "",
    country=org.country or "",
    city=org.city or "",
    address=org.address or "",
    rating=org.rating or "",
    reviews_count=org.reviews_count or "",
    website=org.website or "",
    email=org.email or "",
    phone=org.phone or "",
    telegram=org.telegram or "",
    vk=org.vk or "",
    instagram=org.instagram or "",
    whatsapp=org.whatsapp or "",
    card_url=org.card_url or "",
    working_hours=org.working_hours or "",
    categories=org.categories or "",
  )


@app.get("/health")
async def health():
  return {"ok": True}


@app.post("/collect-links", response_model=CollectLinksResponse)
async def collect_links(req: CollectLinksRequest):
  async with _REQUEST_SEMAPHORE:
    parser = YandexMapsParser(proxy_settings=_to_proxy_settings(req.proxy), headless=req.headless)
    try:
      links = await asyncio.to_thread(parser.collect_organization_links, req.search_url, req.max_results)
      return CollectLinksResponse(links=links)
    except Exception as e:
      raise HTTPException(status_code=500, detail=str(e))
    finally:
      parser.close()


@app.post("/parse-orgs", response_model=ParseOrgsResponse)
async def parse_orgs(req: ParseOrgsRequest):
  async with _REQUEST_SEMAPHORE:
    parser = YandexMapsParser(proxy_settings=_to_proxy_settings(req.proxy), headless=req.headless)
    try:
      orgs = await asyncio.to_thread(parser.parse_organizations_from_links, req.links)
      return ParseOrgsResponse(organizations=[_org_to_model(o) for o in orgs])
    except Exception as e:
      raise HTTPException(status_code=500, detail=str(e))
    finally:
      parser.close()

