#!/bin/sh
set -eu

if [ -f /run/secrets/app_env ]; then
  set -a
  . /run/secrets/app_env
  set +a
fi

if [ -z "${REIMBURSEMENT_DATABASE_URL:-}" ]; then
  REIMBURSEMENT_DATABASE_URL="${DATABASE_URL:-}"
fi

# .env.local addresses local development ports; containers use the private
# Compose network and must never attempt to reconnect through the host.
REIMBURSEMENT_DATABASE_URL="$(printf '%s' "$REIMBURSEMENT_DATABASE_URL" | sed -e 's/@localhost:5433\//@postgres:5432\//' -e 's/@127\.0\.0\.1:5433\//@postgres:5432\//')"
export REIMBURSEMENT_DATABASE_URL
export S3_ENDPOINT="http://minio:9000"
export CLAMAV_HOST="clamav"
export CLAMAV_PORT="3310"
export OCR_SERVICE_URL="http://ocr:8000"

exec "$@"
