---
kind: upgrade-guide
description: "受管 Desktop 现在可通过机器策略强制企业 OIDC 登录。"
---

# 配置受管 Desktop 策略

[English](guide.md) | 中文

## 变更

此前 Desktop 可使用用户可修改的 profile 补丁、模型地址、插件和权限模式。现在它必须有有效机器策略，随附的 `dsh` 命令也仅使用受管 profile。OIDC 策略会关闭 DeepSeek 账户登录、API key 输入和跳过登录入口。

## 迁移

1. 在 macOS 的 `/Library/Application Support/DeepSeek Harness Enterprise/policy.json` 或 Windows 的 `C:\ProgramData\DeepSeek Harness Enterprise\policy.json` 放置 `policy.json`。设置 `version: 1`、获准的 HTTPS `modelGateway`、`workspaceMode`（`read-only` 或 `workspace-write`）及现有绝对路径 `workspaceRoot`。
2. Windows 使用 `pnpm run package:desktop:win:x64:enterprise` 构建并静默部署签名的机器级安装包；安装需要管理员权限，且会禁用自动更新。切换前先卸载 per-user 版本。macOS 通过 MDM 将签名、公证的应用部署到 `/Applications`。
3. 在 macOS 上运行 `sudo bash deploy/enterprise/secure-policy-macos.sh`，或在 Windows 管理员 PowerShell 会话中运行 `powershell -ExecutionPolicy Bypass -File .\deploy\enterprise\Secure-Policy.ps1`。Desktop 启动时复查权限；安装目录只允许管理员写入。
4. 删除 Desktop 或 Harness home 下非空的 `cordis.patch.yml`。每个额外 `approvedBundles` 条目需有精确名称、版本和小写 SHA-256 摘要。运行 `pnpm run enterprise:bundle-hash <package-directory> --root <desktop-node-modules-directory>` 生成摘要，root 指向受保护安装目录的 `node_modules`；签名前按策略顺序加入 bundle。挂载前 Desktop 会检查组合、版本、摘要和路径。摘要记录安装内的符号链接目标并拒绝越界链接，但不计算链接目标或外部依赖摘要。为安装包签名，并只允许管理员写安装目录。API key 网关认证使用现有凭据存储。
5. 配置 SSO 时，设置 HTTPS `issuer`、公开 `clientId`、绝对 `audience`、`gatewayScope` 及包含 `openid` 和该 scope 的唯一 `scopes`。`gatewayScope` 必须匹配 `OIDC_REQUIRED_SCOPE`。将应用注册为 public native client，配置 `127.0.0.1` loopback 回调和 PKCE S256；网关应校验 access token 的 audience 和 scope。仅支持 SAML 的 IdP 需接入 OIDC broker。
6. 确认 Desktop 进入聊天界面并调用获准网关。使用企业 IdP 和网关验证 OIDC 登录、续期、注销及拒绝无效或过期令牌。无效策略会阻止启动。处理敏感数据前，通过防火墙或代理限制 Desktop、子进程和外部浏览器的出站连接。
