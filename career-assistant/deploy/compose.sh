#!/bin/sh
set -eu
# 备份、恢复与运维复用相同配置；服务器必须显式选择已授权的覆盖文件。
career_compose() {
  if [ -n "${CAREER_COMPOSE_OVERRIDE:-}" ]; then
    docker compose --env-file "${CAREER_ENV_FILE:-deploy/.env.production}" -f deploy/compose.yml -f "$CAREER_COMPOSE_OVERRIDE" "$@"
  else
    docker compose --env-file "${CAREER_ENV_FILE:-deploy/.env.production}" -f deploy/compose.yml "$@"
  fi
}
career_compose "$@"
