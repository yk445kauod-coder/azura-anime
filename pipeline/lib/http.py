"""Polite, retrying HTTP client for NASA public APIs."""
from __future__ import annotations

import logging

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from . import config

log = logging.getLogger("ignis.http")


def session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": config.USER_AGENT,
        "Accept": "application/json, text/plain, */*",
    })
    retry = Retry(
        total=4,
        backoff_factor=1.5,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset(["GET", "POST", "HEAD"]),
        respect_retry_after_header=True,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=16, pool_maxsize=16)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


S = session()


def get_json(url: str, params: dict | None = None, timeout: int = 60) -> dict:
    r = S.get(url, params=params, timeout=timeout)
    r.raise_for_status()
    return r.json()


def get_text(url: str, timeout: int = 120) -> str:
    r = S.get(url, timeout=timeout)
    r.raise_for_status()
    return r.text


def get_bytes(url: str, timeout: int = 300) -> bytes:
    r = S.get(url, timeout=timeout, stream=True)
    r.raise_for_status()
    return r.content
