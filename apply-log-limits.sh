#!/usr/bin/env bash
set -euo pipefail
umask 077

stage="检查环境"
backup_dir=""
lock_dir=""
lock_held=0
maintenance=0

fail() { printf '日志配置应用停止：%s\n' "$*" >&2; exit 1; }
step() { stage=$1; printf '\n==> %s\n' "$stage"; }
finish() {
  local result=$?
  trap - EXIT
  if (( lock_held )); then
    rm -f -- "$lock_dir/pid" || true
    rmdir -- "$lock_dir" || printf '请检查遗留维护锁：%s\n' "$lock_dir" >&2
  fi
  if (( result != 0 )); then
    printf '\n未完成，失败阶段：%s（退出码 %s）。\n' "$stage" "$result" >&2
    if (( maintenance )); then
      printf '应用可能仍处于停服状态；确认错误与原数据卷后再恢复，不会自动回滚或继续启动。\n' >&2
    fi
    if [[ -n "$backup_dir" ]]; then printf '备份及诊断文件已保留：%s\n' "$backup_dir" >&2; fi
  fi
  exit "$result"
}

# Resolved config and inspect snapshots contain secrets. Keep them in the private backup directory.
check_snapshot() {
  python3 - "$backup_dir" "$1" <<'PY'
import json
from pathlib import Path
import re
import sys

root, phase = Path(sys.argv[1]), sys.argv[2]
# Compose's canonical JSON already escapes dollar signs for a subsequent parse.
config = json.loads((root / "compose.resolved.json").read_text().replace("$$", "$"))
services = ("postgres", "redis", "api", "worker", "web")

def require(condition, message):
    if not condition:
        sys.exit(message)

def inspect(prefix, name):
    items = json.loads((root / f"{prefix}-{name}.json").read_text())
    require(len(items) == 1, f"{name} 需要且只能有一个容器。")
    return items[0]

def environment(container):
    return dict(item.split("=", 1) for item in container["Config"].get("Env", []) if "=" in item)

def data_mount(container, name):
    target = "/var/lib/postgresql/data" if name == "postgres" else "/data"
    mounts = [mount for mount in container["Mounts"] if mount["Destination"] == target]
    require(len(mounts) == 1 and mounts[0]["Type"] == "volume" and mounts[0].get("RW"), f"{name} 必须使用原有可写命名数据卷。")
    return mounts[0]

require(set(config["services"]) == set(services) | {"migrate"}, "脚本只支持标准六服务 Compose 部署。")
for name, service in config["services"].items():
    logging = service.get("logging", {})
    options = logging.get("options", {})
    require(logging.get("driver") == "json-file"
            and re.fullmatch(r"[1-9][0-9]*[kmg]", str(options.get("max-size", "")), re.I)
            and re.fullmatch(r"[1-9][0-9]*", str(options.get("max-file", "")))
            and options.get("compress") == "true", f"{name} 缺少有效日志限制；请先更新 Compose 日志配置。")

if phase == "plan":
    if (root / "before-migrate.json").exists():
        require(not inspect("before", "migrate")["State"]["Running"], "迁移容器仍在运行，请等待迁移完成后再应用日志配置。")
    for name in services:
        before = inspect("before", name)
        service = config["services"][name]
        labels = before["Config"].get("Labels", {})
        require(before["State"]["Running"], f"{name} 未运行；请先恢复原部署。")
        require(labels.get("com.docker.compose.project") == config["name"]
                and labels.get("com.docker.compose.service") == name, f"{name} 的 Compose 项目身份不匹配。")
        current_env = environment(before)
        if name == "postgres":
            require(current_env.get("POSTGRES_USER") == "masterdns" and current_env.get("POSTGRES_DB") == "masterdns", "脚本仅支持标准 masterdns 数据库及用户，拒绝备份其他目标。")
        require(all(current_env.get(key) == str(value) for key, value in service.get("environment", {}).items()),
                f"{name} 的配置与运行环境不一致（可能涉及密钥或数据库）；请先核对 .env 和 Compose 配置。")
        if name in ("api", "worker"):
            require(current_env.get("MASTER_ENCRYPTION_KEY"), f"{name} 缺少现有加密密钥。")
        require(re.fullmatch(r"sha256:[a-f0-9]{64}", before["Image"]), f"{name} 缺少有效运行镜像 ID。")
        service["image"] = before["Image"]
        service["pull_policy"] = "never"
        service.pop("build", None)
        service["environment"] = current_env
        for field, source in (("command", "Cmd"), ("entrypoint", "Entrypoint")):
            if source in before["Config"]:
                service[field] = before["Config"][source]
        if name in ("postgres", "redis"):
            mount = data_mount(before, name)
            planned = [item for item in service.get("volumes", []) if item["target"] == mount["Destination"]]
            require(len(planned) == 1 and planned[0]["type"] == "volume" and not planned[0].get("read_only"), f"{name} 的数据卷配置不匹配。")
            source = planned[0]["source"]
            require(config["volumes"][source].get("name") == mount["Name"], f"{name} 的目标数据卷与原卷不同，拒绝重建。")
            # Fail if the existing volume is missing; never silently initialize an empty replacement.
            config["volumes"][source] = {"name": mount["Name"], "external": True}
    config["services"]["migrate"]["image"] = config["services"]["api"]["image"]
    config["services"]["migrate"].pop("build", None)

    # Compose interpolates files on every read. Preserve literal dollars in passwords and keys.
    def escape(value):
        if isinstance(value, str):
            return value.replace("$", "$$")
        if isinstance(value, list):
            return [escape(item) for item in value]
        if isinstance(value, dict):
            return {key: escape(item) for key, item in value.items()}
        return value
    (root / "runtime.compose.json").write_text(json.dumps(escape(config), indent=2) + "\n")
    print("预检通过：运行镜像、现有环境、加密密钥及命名数据卷已核对。")
else:
    for name in (("postgres", "redis") if phase == "dependencies" else services):
        before, after = inspect("before", name), inspect("after", name)
        require(after["State"]["Running"] and after["State"].get("Health", {}).get("Status", "healthy") == "healthy", f"{name} 未正常运行。")
        require(after["Image"] == before["Image"], f"{name} 运行镜像发生变化，停止后续操作。")
        require(environment(after) == environment(before), f"{name} 运行环境发生变化，停止后续操作。")
        logging = config["services"][name]["logging"]
        actual = after["HostConfig"]["LogConfig"]
        require(actual["Type"] == logging["driver"] and all(actual["Config"].get(key) == value for key, value in logging["options"].items()), f"{name} 日志限制未生效。")
        if name in ("postgres", "redis"):
            require(data_mount(after, name)["Name"] == data_mount(before, name)["Name"], f"{name} 数据卷发生变化，停止启动应用。")
    print("检查通过：运行镜像、环境、数据卷与日志配置符合预期。")
PY
}

snapshot() {
  local prefix=$1 service container_id
  shift
  for service in "$@"; do
    container_id=$(compose ps -a -q "$service")
    [[ -n "$container_id" && "$container_id" != *$'\n'* ]] || fail "$service 必须有且仅有一个已有容器。"
    docker inspect "$container_id" > "$backup_dir/$prefix-$service.json"
  done
}

main() {
  if [[ $# == 1 && ( $1 == --help || $1 == -h ) ]]; then
    printf '%s\n' '用法：bash apply-log-limits.sh' \
      '为已有单实例 Docker Compose 部署应用日志限制，保留当前镜像、配置和命名数据卷。' \
      '需要 git、python3、Docker Compose v2；执行期间会短暂停服。' \
      'MASTERDNS_BACKUP_ROOT：备份目录，默认项目旁的 masterdns-backups，必须在项目外。' \
      'MASTERDNS_LOG_WAIT_TIMEOUT：服务启动等待秒数，默认 180。'
    return
  fi
  [[ $# == 0 ]] || fail '不支持的位置参数。'
  local repo_dir git_dir backup_root migrate_id
  local wait_timeout=${MASTERDNS_LOG_WAIT_TIMEOUT:-180}
  [[ "$wait_timeout" =~ ^[1-9][0-9]*$ ]] || fail 'MASTERDNS_LOG_WAIT_TIMEOUT 必须为正整数。'
  for dependency in git docker python3; do command -v "$dependency" >/dev/null || fail "需要 $dependency。"; done
  repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
  cd -- "$repo_dir"
  [[ $(git rev-parse --show-toplevel) == "$repo_dir" ]] || fail '脚本必须位于 MasterDNS 仓库根目录。'
  [[ -f .env && -f docker-compose.yml ]] || fail '需要原有 .env 和 docker-compose.yml。'
  git_dir=$(git rev-parse --absolute-git-dir)
  lock_dir="$git_dir/masterdns-update.lock"
  trap finish EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  mkdir -- "$lock_dir" 2>/dev/null || fail "已有升级/维护进程或遗留锁：$lock_dir；请确认后再操作。"
  lock_held=1
  printf '%s\n' "$$" > "$lock_dir/pid"

  docker compose version
  case "$(docker compose up --help)" in
    *--wait-timeout*) ;;
    *) fail 'Docker Compose 需要支持 up --wait / --wait-timeout。' ;;
  esac
  docker compose config --quiet
  backup_root=${MASTERDNS_BACKUP_ROOT:-"$(dirname -- "$repo_dir")/masterdns-backups"}
  mkdir -p -- "$backup_root"
  backup_root=$(cd -- "$backup_root" && pwd -P)
  case "$backup_root/" in "$repo_dir/"*) fail '备份必须位于项目目录外。' ;; esac
  backup_dir=$(mktemp -d "$backup_root/log-limits-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
  step "备份配置并核对现有容器"
  cp -- .env "$backup_dir/.env"
  cp -- docker-compose.yml "$backup_dir/docker-compose.yml"
  docker compose config --format json > "$backup_dir/compose.resolved.json"
  compose() { docker compose "$@"; }
  snapshot before postgres redis api worker web
  migrate_id=$(compose ps -a -q migrate)
  if [[ -n "$migrate_id" ]]; then
    [[ "$migrate_id" != *$'\n'* ]] || fail '发现多个迁移容器，请先核对。'
    docker inspect "$migrate_id" > "$backup_dir/before-migrate.json"
  fi
  check_snapshot plan
  compose() { docker compose --env-file /dev/null --project-directory "$repo_dir" -f "$backup_dir/runtime.compose.json" "$@"; }
  compose config --quiet
  compose logs --no-color --tail=200 > "$backup_dir/recent-containers.log"
  printf '备份目录：%s\n' "$backup_dir"

  step "停止应用写入"
  maintenance=1
  compose stop web api worker migrate
  step "备份并检查数据库归档"
  compose exec -T postgres pg_dump -U masterdns -d masterdns -Fc > "$backup_dir/masterdns.dump.partial"
  [[ -s "$backup_dir/masterdns.dump.partial" ]] || fail '数据库备份为空。'
  compose exec -T postgres pg_restore --file=/dev/null < "$backup_dir/masterdns.dump.partial"
  mv -- "$backup_dir/masterdns.dump.partial" "$backup_dir/masterdns.dump"

  step "重建 PostgreSQL 与 Redis 并核对原数据卷"
  compose up -d --no-deps --no-build --pull never --force-recreate --wait --wait-timeout "$wait_timeout" postgres redis
  snapshot after postgres redis
  check_snapshot dependencies
  step "重建并检查 API"
  compose up -d --no-deps --no-build --pull never --force-recreate --wait --wait-timeout "$wait_timeout" api
  step "重建 Web 与 Worker"
  compose up -d --no-deps --no-build --pull never --force-recreate --wait --wait-timeout "$wait_timeout" worker web
  snapshot after postgres redis api worker web
  check_snapshot complete
  compose rm -f migrate
  maintenance=0
  compose ps
  printf '\n日志限制已应用。原配置、运行镜像和数据卷已核对；备份保留在：%s\n' "$backup_dir"
}

main "$@"
