#!/bin/sh
set -eu
# 恢复只操作当前显式配置的Compose项目；须先停止业务流量并检查目标。
db_backup=${1:?提供数据库dump}
file_backup=${2:?提供文件备份tar.gz}
[ -f "$db_backup" ] && [ -f "$file_backup" ]
sh deploy/compose.sh stop web worker agent api
sh deploy/compose.sh exec -T database pg_restore -U career -d career --clean --if-exists --exit-on-error < "$db_backup"
sh deploy/compose.sh run --rm --no-deps --user root --entrypoint tar api -C /app/var -xzf - < "$file_backup"
sh deploy/compose.sh run --rm --no-deps --user root --entrypoint chown api -R node:node /app/var/private /app/var/exports
if [ -n "${CAREER_COMPOSE_OVERRIDE:-}" ]; then
  # 旧快照可能缺少已用额度或后续删除屏障，必须先对账再恢复对外服务。
  printf '%s\n' '数据已恢复；业务保持停止。核对已用来源额度、删除记录和目标配置后，再显式启动服务。'
else
  sh deploy/compose.sh up -d api agent worker web
fi
