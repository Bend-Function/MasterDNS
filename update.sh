#!/usr/bin/env bash
set -euo pipefail
umask 077

stage="检查环境"
backup_dir=""
lock_dir=""
lock_held=0
maintenance=0

fail() { printf '升级停止：%s\n' "$*" >&2; exit 1; }
step() { stage=$1; printf '\n==> %s\n' "$stage"; }
finish() {
  local result=$?
  trap - EXIT
  if (( lock_held )); then
    rm -f -- "$lock_dir/pid" || true
    rmdir -- "$lock_dir" || printf '请检查遗留升级锁：%s\n' "$lock_dir" >&2
  fi
  if (( result != 0 )); then
    printf '\n升级未完成，失败阶段：%s（退出码 %s）。\n' "$stage" "$result" >&2
    if (( maintenance )); then
      printf '应用可能仍在维护状态；请检查错误和容器状态，不要跳过迁移错误启动服务。\n' >&2
    fi
    if [[ -n "$backup_dir" ]]; then printf '已保留备份及诊断文件：%s\n' "$backup_dir" >&2; fi
  fi
  exit "$result"
}

main() {
  if [[ $# == 1 && ( $1 == --help || $1 == -h ) ]]; then
    printf '%s\n' '用法：bash update.sh' \
      '更新已有 MasterDNS Docker Compose 部署到 origin/master。' \
      'MASTERDNS_BACKUP_ROOT：备份目录，默认项目旁的 masterdns-backups；必须在项目目录外。' \
      'MASTERDNS_UPDATE_WAIT_TIMEOUT：启动等待秒数，默认 180。'
    return
  fi
  [[ $# == 0 ]] || fail '不支持的位置参数；运行 bash update.sh --help 查看用法。'
  local repo_dir git_dir backup_root backup_id container_id image_id service ref
  local wait_timeout=${MASTERDNS_UPDATE_WAIT_TIMEOUT:-180}
  [[ "$wait_timeout" =~ ^[1-9][0-9]*$ ]] || fail 'MASTERDNS_UPDATE_WAIT_TIMEOUT 必须为正整数。'
  repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
  cd -- "$repo_dir"
  command -v git >/dev/null || fail '需要 git。'
  command -v docker >/dev/null || fail '需要 Docker 和 Docker Compose v2。'
  [[ $(git rev-parse --show-toplevel) == "$repo_dir" ]] || fail 'update.sh 必须位于 MasterDNS Git 仓库根目录。'
  [[ -f .env && -f docker-compose.yml ]] || fail '需要已有部署的 .env 和 docker-compose.yml。'
  git diff --quiet && git diff --cached --quiet || fail '工作区存在未提交修改，请先保存后重试；脚本不会覆盖这些修改。'
  git_dir=$(git rev-parse --absolute-git-dir)
  lock_dir="$git_dir/masterdns-update.lock"
  trap finish EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  mkdir -- "$lock_dir" 2>/dev/null || fail "已有升级进程或遗留锁：$lock_dir；确认对应进程退出后再处理。"
  lock_held=1
  printf '%s\n' "$$" > "$lock_dir/pid"

  docker compose version
  case "$(docker compose up --help)" in
    *--wait-timeout*) ;;
    *) fail 'Docker Compose 版本过旧，需要支持 up --wait / --wait-timeout。' ;;
  esac
  docker compose config --quiet

  step "备份配置与运行镜像"
  backup_root=${MASTERDNS_BACKUP_ROOT:-"$(dirname -- "$repo_dir")/masterdns-backups"}
  mkdir -p -- "$backup_root"
  backup_root=$(cd -- "$backup_root" && pwd -P)
  case "$backup_root/" in "$repo_dir/"*) fail '备份必须放在项目目录外，避免进入 Docker 构建上下文。' ;; esac
  backup_dir=$(mktemp -d "$backup_root/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
  backup_id=${backup_dir##*/}
  cp -- .env "$backup_dir/.env"
  cp -- docker-compose.yml "$backup_dir/docker-compose.yml"
  git rev-parse HEAD > "$backup_dir/checkout-revision.txt"
  git branch --show-current > "$backup_dir/checkout-branch.txt"
  docker compose config > "$backup_dir/compose.resolved.yml"
  for service in api worker web; do
    container_id=$(docker compose ps -a -q "$service")
    [[ -n "$container_id" && "$container_id" != *$'\n'* ]] || fail "$service 必须有且仅有一个已有容器；本脚本适用于单实例部署。"
    image_id=$(docker inspect --format '{{.Image}}' "$container_id")
    [[ -n "$image_id" ]] || fail "无法读取 $service 运行镜像。"
    printf '%s\n' "$image_id" > "$backup_dir/$service-image.txt"
    docker image tag "$image_id" "masterdns-backup-$service:$backup_id"
  done
  printf '备份目录：%s\n' "$backup_dir"

  step "更新 master 源码"
  git fetch origin
  for ref in HEAD master origin/master; do
    if git cat-file -e "$ref:.env" 2>/dev/null; then
      fail "$ref 包含受跟踪的 .env，拒绝切换分支覆盖现有部署配置。"
    fi
  done
  git switch master
  git merge-base --is-ancestor HEAD origin/master || fail '本地 master 含有远端没有的提交，请先处理分叉后重试。'
  git merge --ff-only origin/master
  git rev-parse HEAD > "$backup_dir/target-revision.txt"
  docker compose config --quiet

  step "构建新版本"
  docker compose build
  step "只读升级预检"
  docker compose run --rm --no-deps migrate node packages/db/dist/preflight-cli.js

  step "停止应用写入"
  maintenance=1
  docker compose stop web api worker migrate
  step "备份数据库"
  docker compose exec -T postgres pg_dump -U masterdns -d masterdns -Fc > "$backup_dir/masterdns.dump.partial"
  [[ -s "$backup_dir/masterdns.dump.partial" ]] || fail '数据库备份为空。'
  mv -- "$backup_dir/masterdns.dump.partial" "$backup_dir/masterdns.dump"
  docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U masterdns -d masterdns \
    -c 'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id' > "$backup_dir/migrations.txt"

  step "停服后预检"
  docker compose run --rm --no-deps migrate node packages/db/dist/preflight-cli.js
  step "执行数据库迁移"
  docker compose run --rm --no-deps migrate
  step "启动并检查 API"
  docker compose up -d --no-deps --no-build --wait --wait-timeout "$wait_timeout" api
  step "启动 Web 与 Worker"
  docker compose up -d --no-deps --no-build --wait --wait-timeout "$wait_timeout" worker web
  maintenance=0
  docker compose ps
  printf '\n升级完成。备份与旧镜像保留，备份目录：%s\n' "$backup_dir"
}

# Parse the entire workflow before fetching a version that may replace this file.
main "$@"
