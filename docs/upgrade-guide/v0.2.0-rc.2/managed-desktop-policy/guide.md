---
kind: upgrade-guide
description: "Desktop now requires a machine-owned enterprise policy before it starts."
---

# Configure the managed Desktop policy

English | [中文](guide.zh.md)

## Change

Desktop previously opened with user-controlled profile patches, model endpoints, plugins, and permission modes. It now refuses to start without a valid machine policy and restricts these settings to the managed composition. The Desktop-bundled `dsh` command no longer manages plugins or launches other profiles.

## Migration

1. Provision `policy.json` at `/Library/Application Support/DeepSeek Harness Enterprise/policy.json` on macOS or `C:\ProgramData\DeepSeek Harness Enterprise\policy.json` on Windows. Set `version` to `1`, `modelGateway` to an approved HTTPS Messages gateway, `workspaceMode` to `read-only` or `workspace-write`, and `workspaceRoot` to an existing absolute directory containing approved workspaces.
2. On macOS, run `sudo bash deploy/enterprise/secure-policy-macos.sh` after placing the policy. On Windows, run `powershell -ExecutionPolicy Bypass -File .\deploy\enterprise\Secure-Policy.ps1` from an elevated Administrator session. The application checks the policy permissions again at startup. Keep the installation directory user-read-only.
3. Remove custom Desktop bundles and nonempty Desktop or Harness-home `cordis.patch.yml` files. Configure endpoint credentials through the existing credential store.
4. Start Desktop and confirm that it reaches the chat view and requests the approved gateway. A missing or invalid policy produces an `enterprise policy` startup error. Apply enterprise firewall or proxy rules to the application and its child processes before handling sensitive data.
