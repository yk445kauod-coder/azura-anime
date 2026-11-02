#!/usr/bin/env bash
# Deploy the IGNIS LLM gateway (functions/ignisllm) to Neon and wire the URL
# back into .env. Run `neon auth` first if you have not signed in.
set -euo pipefail

cd "$(dirname "$0")/.."

NEON_BIN="npx -y neon@8.16.0"
ENV_FILE=".env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found" >&2
  exit 1
fi

for key in AGENTROUTER_API_KEY IGNIS_PROXY_TOKEN; do
  if ! grep -qE "^${key}=\"?[^\"]+" "$ENV_FILE"; then
    echo "error: $key is empty in $ENV_FILE (neon.ts declares it, so deploy will fail)" >&2
    exit 1
  fi
done

echo "==> Checking Neon auth"
if ! $NEON_BIN profile list -o json 2>/dev/null | grep -q '"account": *"[^-]'; then
  echo "error: no Neon account credentials. Run 'neon auth' (browser sign-in) and retry." >&2
  exit 1
fi

echo "==> Deploying functions/ignisllm"
$NEON_BIN deploy --env "$ENV_FILE"

echo "==> Reading the invocation URL"
URL="$($NEON_BIN functions get ignisllm -o json \
        | python3 -c 'import json,sys; print(json.load(sys.stdin).get("invocation_url",""))')"

if [[ -z "$URL" ]]; then
  echo "error: could not read invocation_url; run 'neon functions get ignisllm'" >&2
  exit 1
fi

python3 - "$URL" <<'PY'
import pathlib, re, sys
url = sys.argv[1]
p = pathlib.Path(".env")
s = p.read_text()
s, n = re.subn(r'^IGNIS_AGENTROUTER_PROXY_URL=.*$',
               f'IGNIS_AGENTROUTER_PROXY_URL="{url}"', s, flags=re.M)
if n == 0:
    s = s.rstrip("\n") + f'\nIGNIS_AGENTROUTER_PROXY_URL="{url}"\n'
p.write_text(s)
print(f"wrote IGNIS_AGENTROUTER_PROXY_URL={url}")
PY

echo "==> Verifying /health through the function"
curl -s --max-time 60 "${URL%/}/health" | head -c 300
echo

echo
echo "Done. The chain now tries agentrouter_proxy first:"
echo "  npm run pipeline:doctor"
