import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { bundlePatchPaths, composeEntries, enterprisePolicyPath, loadEnterprisePolicy, loadOverlayPatches,
  readProfilePatches, type Profile } from '../src/index.ts'

const windowsAcl = vi.hoisted(() => ({ check: vi.fn() }))
vi.mock('../src/windows-policy-acl.ts', () => ({ assertWindowsPolicyAcl: windowsAcl.check }))

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-enterprise-policy-')))
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const policy = { version: 1 as const, modelGateway: 'https://gateway.example.test/anthropic',
  workspaceMode: 'read-only' as const, workspaceRoot: root }

describe('managed Desktop policy', () => {
  it('uses machine paths and refuses absent, public, and malformed gateways', () => {
    expect(enterprisePolicyPath('darwin')).toContain('/Library/Application Support/')
    expect(enterprisePolicyPath('win32')).toContain('C:\\ProgramData\\')
    const file = join(root, 'policy.json')
    expect(() => loadEnterprisePolicy(file, 'win32')).toThrow()
    for (const modelGateway of ['https://api.deepseek.com/anthropic', 'http://internal.test', 'https://good.test/?x=1']) {
      writeFileSync(file, JSON.stringify({ ...policy, modelGateway }))
      expect(() => loadEnterprisePolicy(file, 'win32')).toThrow('modelGateway')
    }
    writeFileSync(file, JSON.stringify({ ...policy, extra: true }))
    expect(() => loadEnterprisePolicy(file, 'win32')).toThrow('expected version 1')
    writeFileSync(file, JSON.stringify(policy))
    expect(loadEnterprisePolicy(file, 'win32')).toEqual(policy)
  })

  it('checks Windows machine policy permissions before reading the file', () => {
    const file = enterprisePolicyPath('win32')
    expect(() => loadEnterprisePolicy(file, 'win32')).toThrow()
    expect(windowsAcl.check).toHaveBeenCalledWith(resolve(file))
  })

  it.skipIf(process.platform !== 'darwin')('rejects a user-owned policy ancestry on macOS', () => {
    const file = join(root, 'policy.json')
    expect(() => loadEnterprisePolicy(file, 'darwin')).toThrow('root-owned')
  })

  it('refuses user layers and removes execution, network, and plugin controls from the final tree', () => {
    const profile: Profile = {
      name: 'desktop', dir: root, patchPath: join(root, 'missing.patch.yml'), patches: [], skippedBundles: [],
      layers: [
        { packageName: '@deepseek-ai/dsh-base', packageDir: root, patchPaths: [], patches: [{ insert: [
          { id: 'llm-deepseek', name: 'model' }, { id: 'sandbox-policy', name: 'sandbox' },
          { id: 'tool-bash', name: 'shell' }, { id: 'web-fetch-http', name: 'fetch' },
          { id: 'plugin-manager', name: 'plugins' }, { id: 'session-telemetry-otel', name: 'telemetry' },
        ] }] },
        { packageName: '@deepseek-ai/dsh-web-app', packageDir: root, patchPaths: [], patches: [{ insert: [
          { id: 'preset-standard', name: 'preset', config: { id: 'standard', plugins: [{ id: 'tool-bash', name: 'shell' }] } },
          { id: 'preset-minimal', name: 'preset', config: { id: 'minimal', plugins: [] } },
        ] }] },
      ],
    }
    const context = {
      name: 'desktop', dir: root, patchPath: profile.patchPath, installAnchor: '', home: root, cwd: root,
      startedBundles: profile.layers.map(layer => layer.packageName), overlays: [], telemetryDisabledEnv: undefined,
      enterprisePolicy: policy,
    }
    const entries = composeEntries([readProfilePatches('test', context, profile)])
    const row = (id: string) => entries.find(entry => entry.id === id)
    for (const id of ['tool-bash', 'web-fetch-http', 'plugin-manager', 'session-telemetry-otel', 'preset-minimal']) {
      expect(row(id)?.disabled).toBe(true)
    }
    expect(row('preset-standard')?.config).toEqual({ id: 'standard', order: 1, plugins: [] })
    expect(row('llm-deepseek')?.config).toEqual({ baseURL: policy.modelGateway })
    expect(row('sandbox-policy')?.config).toMatchObject({ mode: 'read-only', maximumMode: 'read-only', allowedWorkspaceRoot: root })
    expect(() => readProfilePatches('test', { ...context, overlays: [{ id: 'tool-bash', disabled: false }] }, profile))
      .toThrow('empty profile, home and launch patches')
    expect(() => readProfilePatches('test', context, { ...profile, patches: [{ id: 'tool-bash', disabled: false }] }))
      .toThrow('empty profile, home and launch patches')
    expect(() => readProfilePatches('test', context, { ...profile, layers: profile.layers.slice(0, 1) }))
      .toThrow('shipped bundles')
  })

  it('locks the shipped Desktop composition, including nested agent presets', () => {
    const baseDir = join(import.meta.dirname, '../../../bundle/base')
    const webDir = join(import.meta.dirname, '../../../bundle/web-app')
    const layer = (packageName: string, packageDir: string) => {
      const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
        dsh: { bundle: { patch: string | string[] } }
      }
      const patchPaths = bundlePatchPaths(packageDir, manifest.dsh.bundle)
      return { packageName, packageDir, patchPaths,
        patches: patchPaths.flatMap(path => loadOverlayPatches('test', path)) }
    }
    const profile: Profile = {
      name: 'desktop', dir: root, patchPath: join(root, 'missing.patch.yml'), patches: [], skippedBundles: [],
      layers: [layer('@deepseek-ai/dsh-base', baseDir), layer('@deepseek-ai/dsh-web-app', webDir)],
    }
    const entries = composeEntries([readProfilePatches('test', {
      name: 'desktop', dir: root, patchPath: profile.patchPath, installAnchor: '', home: root, cwd: root,
      startedBundles: profile.layers.map(item => item.packageName), overlays: [], telemetryDisabledEnv: undefined,
      enterprisePolicy: policy,
    }, profile)])
    const row = (id: string) => entries.find(entry => entry.id === id)
    expect(row('preset-standard')?.config).toMatchObject({ plugins: [] })
    for (const id of ['preset-minimal', 'preset-ptc', 'preset-cordis', 'tool-bash', 'tool-pwsh',
      'tool-web', 'plugin-manager', 'llm-pi-ai', 'web-fetch-http', 'desktop-product-telemetry']) {
      expect(row(id)?.disabled, id).toBe(true)
    }
  })
})
