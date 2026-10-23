# Docker 容器日志限制验证

日期：2026-10-23。基于 `a633d0e` 后的本次配置变更；本记录不扩大此前业务测试和真实云验收范围。

## 问题与实现

原 Compose 解析结果中，`api`、`worker`、`web`、`postgres`、`redis`、`migrate` 的 `logging` 均为空，项目没有设置日志轮转上限，实际行为依赖 Docker daemon 的默认配置。用户反馈 Docker 占用过大；本次未访问生产主机，不能据此确定其全部磁盘占用均来自日志。

六个服务现在共用 `json-file` 配置：默认 `max-size="10m"`、`max-file="3"`、`compress="true"`。`DOCKER_LOG_MAX_SIZE` / `DOCKER_LOG_MAX_FILES` 允许部署覆盖，未设置或为空时采用默认值。文件数量包含当前文件。没有修改应用代码、数据库保留策略、命名卷、迁移或升级脚本。

已有容器需要重建；部署手册提供维护窗口内停止应用、重建依赖与应用、移除已停止旧迁移容器和检查实际日志配置的顺序。`update.sh` 保留 PostgreSQL/Redis 的既有行为已在文档中明确。日志轮转不能限制镜像、构建缓存、数据库卷和外部备份的空间。

## 本次验证

- 修改前，用真实 Compose 解析器确认全部六个服务未定义 `logging`。
- 修改后，使用本机独立 `docker-compose` 5.3.1 的 `config --format json`，指定 `--env-file /dev/null`，仅提供占位数据库密码、初始化密码和测试密钥；未读取部署 `.env`。
- 四组配置全部通过：变量未设置时为 `10m` / `3`；显式覆盖为 `5m` / `2`；变量均为空时回落 `10m` / `3`；单文件保留为 `1m` / `1`。每组均核对全部六个服务、字符串选项、压缩开关，确认日志配置没有传入应用环境变量，并且 PostgreSQL/Redis 仍引用原有命名卷。
- `git diff --check` 通过，变更文档的本地链接检查通过。
- 仅修改配置与文档，未重跑此前 609 项业务测试；此前结果不能作为本次配置的运行验证。

本机没有运行中的 Docker daemon，且 `docker compose` 插件未注册，验证使用可用的独立 `docker-compose` 命令。未实际创建容器或验证磁盘上的日志轮转、压缩及回收；未重启生产服务、删除日志、镜像、缓存或数据卷。生产环境应按[部署手册](../DEPLOYMENT.md)重建并检查 `HostConfig.LogConfig`；隔离环境中的实际轮转验收见[测试计划](../TEST_PLAN.md)。

选项语义依据 [Docker json-file 官方文档](https://docs.docker.com/engine/logging/drivers/json-file/)。
