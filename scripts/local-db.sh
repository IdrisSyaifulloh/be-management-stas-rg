#!/usr/bin/env bash
set -euo pipefail

COMPOSE_SERVICE=${1:-postgres}
CONTAINER_NAME=stasrg-postgres
DB_PORT=${DB_PORT:-5433}

echo "Starting Postgres container..."
docker-compose up -d "$COMPOSE_SERVICE"

echo "Waiting for Postgres to be ready..."
until docker exec "$CONTAINER_NAME" pg_isready -U postgres -d stasrg >/dev/null 2>&1; do
  printf '.'
  sleep 1
done

echo "\nPostgres ready."

export DB_PORT

echo "Running migrations..."
DB_PORT=$DB_PORT npm run db:migrate

echo "Running seed..."
DB_PORT=$DB_PORT npm run db:seed

echo "Local DB setup complete."
