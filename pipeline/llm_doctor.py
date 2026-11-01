"""LLM provider diagnostics — find out which providers actually answer.

Sends one minimal request to each configured provider and reports the outcome,
so a blocked gateway or a bad model name is obvious instead of surfacing as a
silently degraded answer.

    python3 pipeline/llm_doctor.py
    python3 pipeline/llm_doctor.py --provider agentrouter
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import llm as llm_mod  # noqa: E402

log = logging.getLogger("ignis.doctor")

PROBE_SYSTEM = "You are a health check. Reply with exactly: OK"
PROBE_USER = "Reply OK only."


def _classify(exc: Exception) -> str:
    """Turn a provider error into an actionable diagnosis."""
    text = str(exc)
    low = text.lower()
    if "non-json content" in low and "text/html" in low:
        return ("WAF / gateway interstitial — the endpoint returned an HTML "
                "verification page instead of JSON. Requests from this network "
                "are not on the gateway's allowlist.")
    if "503" in text:
        return "upstream capacity or quota — the model pool is temporarily empty."
    if "429" in text:
        return "rate limited — retry later or lower the request rate."
    if "401" in text or "403" in text:
        return "authentication rejected — check the API key."
    if "404" in text:
        return "endpoint or model name not found — check the base URL and model."
    if "402" in text:
        return "budget/quota exhausted on the account."
    if "timed out" in low or "timeout" in low:
        return "network timeout — host unreachable from here."
    if "name or service not known" in low or "nodename" in low:
        return "DNS resolution failed — host not reachable from this network."
    return "unclassified failure."


def probe(provider, timeout: int = 45) -> dict:
    llm = llm_mod.LLM(enabled=False)
    llm.providers = [provider]
    llm.timeout = timeout
    llm.retries = 1
    t0 = time.time()
    try:
        result = llm.complete(PROBE_SYSTEM, PROBE_USER, max_tokens=16, use_cache=False)
        return {
            "provider": provider.name,
            "model": provider.model,
            "protocol": provider.style,
            "base_url": provider.base_url,
            "status": "ok",
            "latency_ms": int((time.time() - t0) * 1000),
            "sample": result.text[:60],
        }
    except Exception as exc:
        return {
            "provider": provider.name,
            "model": provider.model,
            "protocol": provider.style,
            "base_url": provider.base_url,
            "status": "failed",
            "latency_ms": int((time.time() - t0) * 1000),
            "error": str(exc).splitlines()[0][:200],
            "diagnosis": _classify(exc),
        }


def main() -> int:
    ap = argparse.ArgumentParser(description="Probe each configured LLM provider")
    ap.add_argument("--provider", help="probe only this provider")
    ap.add_argument("--timeout", type=int, default=45)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(level=logging.CRITICAL)
    providers = llm_mod._detect_providers()
    if args.provider:
        providers = [p for p in providers if p.name == args.provider]
    if not providers:
        print("No providers configured. Set GEMINI_API_KEY and/or "
              "AGENTROUTER_API_KEY in .env.")
        return 1

    results = [probe(p, args.timeout) for p in providers]
    if args.json:
        print(json.dumps(results, indent=2))
        return 0 if any(r["status"] == "ok" for r in results) else 1

    print(f"Probing {len(results)} provider(s) — one minimal request each.\n")
    for r in results:
        mark = "PASS" if r["status"] == "ok" else "FAIL"
        print(f"[{mark}] {r['provider']}/{r['model']}  ({r['protocol']}, {r['base_url']})")
        print(f"       {r['latency_ms']} ms")
        if r["status"] == "ok":
            print(f"       replied: {r['sample']!r}")
        else:
            print(f"       error:   {r['error']}")
            print(f"       cause:   {r['diagnosis']}")
        print()

    ok = [r for r in results if r["status"] == "ok"]
    if ok:
        print(f"{len(ok)}/{len(results)} provider(s) healthy. "
              f"Chain order: {', '.join(p.label for p in providers)}")
        return 0
    print("No provider answered. IGNIS will fall back to the extractive "
          "synthesizer (grounded and cited, but verbatim rather than fluent).")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
