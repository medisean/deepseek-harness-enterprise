# 企业模型网关

[English](README.md) | 中文

网关接收受管 Desktop 客户端的 OIDC Bearer access token，验证签名和授权声明，再使用服务端保存的 API key 转发允许列表中的 DeepSeek Messages 请求。网关生成结构化审计事件，不记录请求或响应内容。共享 Redis 通过原子操作跨网关副本执行 subject 和 tenant 并发限制。开发模式可以使用进程内限流器；生产模式未配置 `REDIS_URL` 时拒绝启动。

必须显式配置 `DEEPSEEK_UPSTREAM_BASE_URL`，选择企业批准的 HTTPS 推理服务；Compose 不会默认把请求发送到公共模型服务。请求和响应内容会原样转发到该上游；本网关不提供私有推理，也不会改变上游的数据保留策略。只有在企业批准其数据处理方式后，才将地址设为 DeepSeek 官方 API，并配置对应的出站网络规则。

## 使用 Docker Compose 部署

使用固定的仓库发布版本或提交。在本目录将 `.env.example` 复制为 `.env`，填写准确的 issuer、JWKS URL、audience、必需 scope、租户声明和批准的模型列表。Compose 默认提供本地 Redis 配额存储；若网关副本运行在该 Compose 项目之外，请将 `REDIS_URL` 设置为共享且经过认证的 `rediss://` 服务地址。将 `tenants.json.example` 复制为 `tenants.json`，并替换为 IdP 实际签发的租户标识、模型子集、token 上限和并发限制。网关在启动时读取该文件；修改策略后需重启或替换服务。将上游 API key 保存到 `secrets/deepseek_api_key`，并限制为部署管理员可读。不要提交 `.env`、`tenants.json` 或 `secrets/`。

Docker 构建上下文仅包含网关源码、包清单、锁文件、工作区配置和已审查补丁。`.env`、`tenants.json` 和 `secrets/` 会同时从 Git 和镜像构建上下文中排除。

```sh
mkdir -p secrets
sudo chown root:root secrets
sudo chmod 700 secrets
sudo install -o root -g root -m 0440 /dev/null secrets/deepseek_api_key
cp tenants.json.example tenants.json
# Replace the sample tenant names, model lists, and limits before starting the service.
sudo chown root:root tenants.json
sudo chmod 0440 tenants.json
# Write the key using your secret manager while preserving root:root and mode 0440, then:
docker compose up --build -d
```

网关容器只在宿主机 loopback 的 8080 端口监听。请在前面配置企业 TLS 反向代理，并转发 `/anthropic/v1/messages`；受管 Desktop 的 `modelGateway` 和 OIDC `audience` 应指向该公开 HTTPS URL。将 `/healthz` 和 `/readyz` 限制为本机或监控网络访问。Redis 不可用时，`/readyz` 返回失败，模型请求以 HTTP 503 失败关闭，直到 Redis 恢复。使用企业现有防火墙或网络策略限制入站和出站流量。Compose 示例对网关启用了只读文件系统、非 root 用户、删除 Linux capabilities 和资源限制；Redis 使用持久化卷、同步 fsync 的 AOF、禁止淘汰、无宿主机端口映射及独立内存上限。网关容器进程会加入补充组 0，以读取 root 所有者、权限为 `0440` 的密钥文件；不要放宽宿主机文件权限。

## 身份与授权

在企业 IdP 中注册 public native OIDC client，并按[仓库企业部署说明](../../../ENTERPRISE.zh.md)配置 loopback PKCE 回调。IdP 必须签发 RS256 access token，且包含与配置完全匹配的 `iss`、网关 `aud`、`sub`、`exp`、必需 scope（`scope` 或 `scp`），以及 `OIDC_TENANT_CLAIM` 指定的字符串声明。`tenants.json` 必须列出所有获准租户。每个条目可限制该租户可用的模型、单个请求的 `max_tokens` 上限，以及租户所有用户可同时发起的请求数。全局模型列表仍是上限，按 subject 的单用户并发限制仍然生效。未知租户或超出租户模型、token 上限的请求会被拒绝。配置 `REDIS_URL` 后，tenant 与 subject 租约会在网关副本之间共享。网关启动前必须能够连接该存储；请求期间 Redis 出错会失败关闭，不会跳过限流。进程崩溃遗留的计数会由租约过期时间回收。

服务只接受 `POST /anthropic/v1/messages`，并拒绝其他路径、缺失或无效的 Bearer token、缺少 scope、`tenants.json` 未列出的租户、超出全局或租户模型允许列表的请求、无效或超限的 `max_tokens`、超大请求体，以及超出 subject 或租户并发上限的请求。服务不保存对话或令牌。上游 API key 保存在挂载的密钥文件中，不会发送给客户端。

## 审计与运维

每个模型请求会向容器 stdout 写入一条 JSON 事件，字段包括生成的 request ID、UTC 时间、已验证的 subject 和可选 tenant、模型、授权决策、结果、HTTP 状态、耗时，以及上游报告的 token 用量。事件不包含提示词、附件、模型回答、access token 或上游 API key。请将 stdout 转发到企业日志系统，并配置严格访问控制、获批的保留期限和防篡改保护。事件流本身不提供持久化存储或告警。

监控 `/healthz`、`/readyz`、上游错误、认证拒绝、限流、Redis 状态和资源使用情况。通过密钥管理工具轮换上游 key，并重启或替换容器。IdP 密钥轮换通过已配置的 JWKS URL 获取。TLS、部署配置与 Redis 卷备份、副本和日志保留由企业基础设施管理；此示例不包含反向代理、持久化审计存储或高可用 Redis 拓扑。

在仓库根目录运行网关单元和 HTTP 集成测试：`pnpm exec vitest run apps/enterprise-gateway/tests/enterprise-gateway.spec.ts`。使用运行中的 Redis 验证共享租约：`REDIS_URL=redis://127.0.0.1:6379/0 pnpm exec vitest run apps/enterprise-gateway/tests/redis-quota.integration.spec.ts`。
