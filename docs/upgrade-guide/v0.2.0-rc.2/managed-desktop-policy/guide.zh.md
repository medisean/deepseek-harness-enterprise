---
kind: upgrade-guide
description: "Desktop 现在必须读取机器级企业策略才能启动。"
---

# 配置受管 Desktop 策略

[English](guide.md) | 中文

## 变更

此前 Desktop 可使用用户可修改的 profile 补丁、模型地址、插件和权限模式。现在它缺少有效机器策略时拒绝启动，并将这些设置限制为受管组合。Desktop 随附的 `dsh` 命令也不再管理插件或启动其他 profile。

## 迁移

1. 在 macOS 的 `/Library/Application Support/DeepSeek Harness Enterprise/policy.json` 或 Windows 的 `C:\ProgramData\DeepSeek Harness Enterprise\policy.json` 放置 `policy.json`。将 `version` 设为 `1`，`modelGateway` 设为经批准的 HTTPS Messages 网关，`workspaceMode` 设为 `read-only` 或 `workspace-write`，`workspaceRoot` 设为包含批准工作区的现有绝对目录。
2. 放置策略后，在 macOS 上运行 `sudo bash deploy/enterprise/secure-policy-macos.sh`；在 Windows 的管理员 PowerShell 会话中运行 `powershell -ExecutionPolicy Bypass -File .\deploy\enterprise\Secure-Policy.ps1`。应用启动时还会再次检查策略权限。安装目录也应禁止普通用户写入。
3. 删除自定义 Desktop bundle，以及 Desktop profile 或 Harness home 下非空的 `cordis.patch.yml`。通过现有凭据存储配置模型网关凭据。
4. 启动 Desktop，确认进入聊天界面且请求发往批准的网关。策略缺失或无效时会出现 `enterprise policy` 启动错误。处理敏感数据前，使用企业防火墙或代理限制应用及其子进程的出站连接。
