#!/bin/sh
set -eu
umask 077
# 通过已加载的Compose配置访问指定项目，不复制应用密钥配置。
backup_root=${1:?提供受保护的备份目录}
mkdir -p "$backup_root"
backup_stamp=$(date -u +%Y%m%dT%H%M%SZ)
sh deploy/compose.sh exec -T database pg_dump -U career -d career -Fc > "$backup_root/database-$backup_stamp.dump"
sh deploy/compose.sh run --rm --no-deps --user root --entrypoint tar api -C /app/var -czf - private exports > "$backup_root/files-$backup_stamp.tar.gz"
