#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Mapping


@dataclass(frozen=True)
class ProbeResult:
    url: str
    status: int | None
    ok: bool
    detail: str


def make_opener(proxy_url: str | None) -> urllib.request.OpenerDirector:
    if proxy_url:
        return urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
        )
    return urllib.request.build_opener()


def fetch_json_ip(opener: urllib.request.OpenerDirector, timeout: float) -> str:
    req = urllib.request.Request(
        "https://api.ipify.org?format=json",
        headers={"User-Agent": "hh-local-probe/1.0"},
    )
    with opener.open(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode("utf-8", errors="replace"))
    ip = payload.get("ip")
    if not ip:
        raise ValueError("ipify response does not contain 'ip'")
    return str(ip)


def probe_url(
    opener: urllib.request.OpenerDirector,
    url: str,
    timeout: float,
    headers: Mapping[str, str],
) -> ProbeResult:
    req = urllib.request.Request(url, headers=dict(headers))
    try:
        with opener.open(req, timeout=timeout) as resp:
            body = resp.read(220).decode("utf-8", errors="replace")
            return ProbeResult(url=url, status=resp.status, ok=True, detail=body.strip())
    except urllib.error.HTTPError as err:
        body = err.read(220).decode("utf-8", errors="replace")
        return ProbeResult(
            url=url,
            status=err.code,
            ok=False,
            detail=body.strip() or f"HTTPError: {err.reason}",
        )
    except urllib.error.URLError as err:
        return ProbeResult(url=url, status=None, ok=False, detail=f"URLError: {err.reason}")
    except TimeoutError:
        return ProbeResult(url=url, status=None, ok=False, detail="TimeoutError")
    except Exception as err:  # noqa: BLE001 - keep output clear for non-dev users
        return ProbeResult(
            url=url,
            status=None,
            ok=False,
            detail=f"{type(err).__name__}: {err}",
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Check HH API availability from local egress IP."
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=15.0,
        help="Request timeout in seconds (default: 15)",
    )
    parser.add_argument(
        "--proxy",
        type=str,
        default=None,
        help="Optional proxy URL, example: http://user:pass@host:port",
    )
    args = parser.parse_args()

    opener = make_opener(args.proxy)
    headers = {"User-Agent": "hh-local-probe/1.0", "Accept": "application/json"}

    print("=== HH local connectivity probe ===")
    print(f"mode: {'proxy' if args.proxy else 'direct'}")
    if args.proxy:
        print(f"proxy: {args.proxy}")

    try:
        ip = fetch_json_ip(opener, timeout=args.timeout)
        print(f"public_ip: {ip}")
    except Exception as err:  # noqa: BLE001 - continue with HH checks
        print(f"public_ip: <failed> ({type(err).__name__}: {err})")

    checks = [
        "https://api.hh.ru/dictionaries",
        "https://api.hh.ru/vacancies?per_page=1",
    ]
    results = [probe_url(opener, url, args.timeout, headers) for url in checks]

    for result in results:
        status = result.status if result.status is not None else "ERR"
        print(f"\n{result.url}")
        print(f"status: {status}")
        print(f"ok: {result.ok}")
        if not result.ok:
            print(f"detail: {result.detail[:200]}")

    vac_result = results[-1]
    if vac_result.status == 403:
        print("\nverdict: HH blocks this egress for vacancies (403).")
        return 2
    if not vac_result.ok:
        print("\nverdict: vacancies endpoint is unavailable from this egress.")
        return 1

    print("\nverdict: vacancies endpoint is reachable from this egress.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
