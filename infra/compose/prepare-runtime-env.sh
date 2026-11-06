#!/usr/bin/env bash
set -euo pipefail
umask 077
ENV_FILE="${1:-.env}"
[[ $# -le 1 && -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || {
  echo "Use prepare-runtime-env.sh with an existing regular .env file" >&2; exit 1;
}
ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"
# Compose parses its own dotenv syntax, including multiline values and the last
# duplicate assignment. Config validation does not contact the Docker daemon.
if ! (unset POSTGRES_APP_PASSWORD; docker compose --project-name coginebot-env-preparation --env-file "$ENV_FILE" -f - config --quiet >/dev/null 2>&1 <<'YAML'
services:
  runtime-env:
    image: scratch
YAML
); then
  echo "The environment file cannot be parsed; set POSTGRES_APP_PASSWORD manually before retrying" >&2; exit 1
fi
if output="$(unset POSTGRES_APP_PASSWORD; docker compose --project-name coginebot-env-preparation --env-file "$ENV_FILE" -f - config --quiet 2>&1 <<'YAML'
services:
  runtime-env:
    image: scratch
    environment:
      PROVIDED: ${POSTGRES_APP_PASSWORD:?COGINEBOT_RUNTIME_PASSWORD_REQUIRED}
YAML
)"; then exit 0; fi
[[ "$output" == *COGINEBOT_RUNTIME_PASSWORD_REQUIRED* ]] || { echo "Cannot verify the runtime password; no environment changes were made" >&2; exit 1; }

password="$(openssl rand -hex 16)"
temporary="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
trap 'rm -f -- "$temporary"' EXIT
cp -p -- "$ENV_FILE" "$temporary"
chmod 600 "$temporary"
# Append rather than rewriting: another secret may contain a key-looking line.
printf '\nPOSTGRES_APP_PASSWORD=%s\n' "$password" >> "$temporary"
mv -- "$temporary" "$ENV_FILE"
