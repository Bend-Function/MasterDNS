# 日志配置应用脚本验证

日期：2026-10-23。基线为 `e9036e5` 后新增的 `apply-log-limits.sh` 及配套测试、文档。本记录只验证该增量，不扩大此前业务测试范围。

## 实现与边界

脚本用于已有标准单实例部署：六个 Compose 服务、五个常驻容器、`masterdns` 数据库和用户、PostgreSQL/Redis 命名数据卷。维护期间与升级脚本共用锁；检查当前环境及加密密钥、数据卷与 Compose 配置一致，拒绝活动迁移，固定现有镜像 ID，并将原卷声明为 external，避免缺卷时新建空库。配置、容器快照和最近日志写入项目外的私有备份目录。

停止应用写入后执行数据库归档并读取校验，成功才重建依赖和应用。复核依赖数据卷后才启动 API，最后检查各服务运行状态、镜像、环境、卷和日志设置。任何阶段失败停止后续操作、保留备份及明确阶段，不进行自动回滚。仅有 `.partial` 文件不能作为已验证备份。Redis 保持原卷，没有另做离线备份。

没有构建或拉取镜像、执行 migration、更新源码、删除数据卷、清理镜像或重置密钥；最后只移除已停止的旧迁移容器。`pg_restore --file=/dev/null` 读取归档但不连接数据库恢复，不能代替恢复演练。配置与数据保留及分阶段失败恢复步骤已同步到[部署手册](../DEPLOYMENT.md)。

## 验证结果

- 首先运行空脚本骨架，成功路径测试因缺少备份失败；实现流程后通过。
- 使用真实 Compose 解析器发现 canonical JSON 已转义 `$`，增加针对性失败测试后修复，验证包含字面 `${...}` 的凭证不会双重转义。
- 新增非标准数据库与活动迁移拒绝用例，确认原流程失败后再补齐预检，两项通过。
- `MASTERDNS_TEST_COMPOSE_BINARY=/opt/homebrew/bin/docker-compose node --test tests/apply-log-limits.test.mjs tests/update.test.mjs`：36 项通过、0 跳过，其中新增脚本 20 项，原升级脚本 16 项。
- 覆盖备份/归档读取/依赖与应用启动失败停止，空归档、错误密钥、错误数据卷、无限日志配置、未运行服务、非标准数据库、活动迁移、镜像/卷/日志读回异常、维护锁、项目内备份目录及包含空格的路径。验证备份权限、原 `.env`、镜像 ID、数据卷和字面凭证保留，以及不调用 migration/build/pull/down/prune。
- 真实 Docker Compose 5.3.1 对生成的 `runtime.compose.json` 重新解析通过，凭证转义、镜像 ID 和 external 原卷一致。
- `bash -n apply-log-limits.sh`、帮助入口、文档本地链接和 `git diff --check` 通过。
- 独立代码审查完成；备份失败后的恢复说明改为按原容器 ID 直接 `docker start`，避免 Compose 启动依赖时重新运行迁移。依赖重建后的恢复保留冻结配置及 `--no-deps` 约束。

流程测试使用真实 Bash、Python、Git 临时仓库和文件系统，Docker 执行边界由 Fake 提供。当前主机没有运行中的 Docker daemon，未执行真实容器重建、数据库恢复或生产操作，也未验证实际磁盘回收。真实环境应检查重建后的 `HostConfig.LogConfig`、原数据卷、API 健康与业务数据；具体入口见[测试计划](../TEST_PLAN.md)。

选项依据：[Docker Compose up](https://docs.docker.com/reference/cli/docker/compose/up/)、[Compose config](https://docs.docker.com/reference/cli/docker/compose/config/)、[PostgreSQL pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)。
