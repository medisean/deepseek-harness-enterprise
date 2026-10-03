import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { bundlePatchPaths, composeEntries, enterprisePolicyPath, loadEnterprisePolicy, loadOverlayPatches,
  readProfilePatches, type Profile } from '../src/index.ts'

const windowsAcl = vi.hoisted(() => ({ check: vi.fn() }))
vi.mock('../src/windows-policy-acl.ts', () => ({ assertWindowsPolicyAcl: windowsAcl.check }))

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-enterprise-policy-')))
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const policy = { version: 1 as const, modelGateway: 'https://gateway.example.test/anthropic',
  workspaceMode: 'read-only' as const, workspaceRoot: root }

function loadBundleLayer(packageName: string, packageDir: string): Profile['layers'][number] {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    dsh: { bundle: { patch: string | string[] } }
  }
  const patchPaths = bundlePatchPaths(packageDir, manifest.dsh.bundle)
  return { packageName, packageDir, patchPaths,
    patches: patchPaths.flatMap(path => loadOverlayPatches('test', path)) }
}

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

  it('accepts only public-client OIDC policy with a secure issuer and OpenID scope', () => {
    const file = join(root, 'oidc-policy.json')
    writeFileSync(file, JSON.stringify({ ...policy, oidc: {
      issuer: 'https://login.example.test/tenant', clientId: 'desktop-client',
      gatewayScope: 'model:run', scopes: ['openid', 'profile', 'model:run'], audience: 'api://model-gateway',
    } }))
    expect(loadEnterprisePolicy(file, 'win32').oidc).toEqual({
      issuer: 'https://login.example.test/tenant', clientId: 'desktop-client',
      gatewayScope: 'model:run', scopes: ['openid', 'profile', 'model:run'], audience: 'api://model-gateway',
    })
    for (const oidc of [
      { issuer: 'http://login.example.test', clientId: 'desktop', gatewayScope: 'model:run', scopes: ['openid', 'model:run'], audience: 'api://model-gateway' },
      { issuer: 'https://login.example.test', clientId: 'desktop', gatewayScope: 'model:run', scopes: ['profile', 'model:run'], audience: 'api://model-gateway' },
      { issuer: 'https://login.example.test', clientId: 'desktop', gatewayScope: 'model:run', scopes: ['openid', 'openid', 'model:run'], audience: 'api://model-gateway' },
      { issuer: 'https://login.example.test', clientId: '', gatewayScope: 'model:run', scopes: ['openid', 'model:run'], audience: 'api://model-gateway' },
      { issuer: 'https://login.example.test', clientId: 'desktop', gatewayScope: 'model:run', scopes: ['openid', 'model:run'], audience: 'not a URI' },
      { issuer: 'https://login.example.test?tenant=1', clientId: 'desktop', gatewayScope: 'model:run', scopes: ['openid', 'model:run'], audience: 'api://model-gateway' },
      { issuer: 'https://login.example.test', clientId: 'desktop', gatewayScope: 'model:run', scopes: ['openid', 'model:run'], audience: 'api://model-gateway', extra: true },
      { issuer: 'https://login.example.test', clientId: 'desktop', gatewayScope: 'model:run', scopes: ['openid', 'model:run'] },
      { issuer: 'https://login.example.test', clientId: 'desktop', gatewayScope: 'model:run', scopes: ['openid'], audience: 'api://model-gateway' },
      { issuer: 'https://login.example.test', clientId: 'desktop', gatewayScope: 'bad scope', scopes: ['openid', 'bad scope'], audience: 'api://model-gateway' },
    ]) {
      writeFileSync(file, JSON.stringify({ ...policy, oidc }))
      expect(() => loadEnterprisePolicy(file, 'win32')).toThrow('enterprise policy: oidc')
    }
  })

  it('accepts only unique exact versions for additional approved bundles', () => {
    const file = join(root, 'approved-bundles-policy.json')
    const approvedBundles = [{ name: '@contoso/dsh-approved-plugin', version: '1.2.3-rc.1' }]
    writeFileSync(file, JSON.stringify({ ...policy, approvedBundles }))
    const parsed = loadEnterprisePolicy(file, 'win32')
    expect(parsed.approvedBundles).toEqual(approvedBundles)
    expect(Object.isFrozen(parsed.approvedBundles)).toBe(true)
    expect(Object.isFrozen(parsed.approvedBundles?.[0])).toBe(true)
    for (const invalid of [
      [{ name: '@contoso/dsh-approved-plugin', version: '^1.2.3' }],
      [{ name: '@contoso/dsh-approved-plugin', version: '1.2' }],
      [{ name: '@contoso/dsh-approved-plugin', version: '1.2.3-' }],
      [{ name: '@deepseek-ai/dsh-base', version: '1.2.3' }],
      [{ name: '../plugin', version: '1.2.3' }],
      [{ name: '@contoso/dsh-approved-plugin', version: '1.2.3', extra: true }],
      [approvedBundles[0], approvedBundles[0]],
    ]) {
      writeFileSync(file, JSON.stringify({ ...policy, approvedBundles: invalid }))
      expect(() => loadEnterprisePolicy(file, 'win32')).toThrow('approvedBundles')
    }
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
    const profile: Profile = {
      name: 'desktop', dir: root, patchPath: join(root, 'missing.patch.yml'), patches: [], skippedBundles: [],
      layers: [loadBundleLayer('@deepseek-ai/dsh-base', baseDir), loadBundleLayer('@deepseek-ai/dsh-web-app', webDir)],
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

  it('loads only machine-approved bundles at the exact version from the signed installation tree', () => {
    const baseDir = join(import.meta.dirname, '../../../bundle/base')
    const webDir = join(import.meta.dirname, '../../../bundle/web-app')
    const modules = join(root, 'signed-desktop', 'node_modules')
    const installAnchor = join(modules, '@deepseek-ai', 'dsh', 'package.json')
    const approvedName = '@contoso/dsh-approved-plugin'
    const approvedDir = join(modules, '@contoso', 'dsh-approved-plugin')
    mkdirSync(dirname(installAnchor), { recursive: true })
    mkdirSync(approvedDir, { recursive: true })
    writeFileSync(installAnchor, JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0' }))
    writeFileSync(join(approvedDir, 'package.json'), JSON.stringify({ name: approvedName, version: '2.4.1',
      dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    const profile: Profile = {
      name: 'desktop', dir: root, patchPath: join(root, 'missing.patch.yml'), patches: [], skippedBundles: [],
      layers: [loadBundleLayer('@deepseek-ai/dsh-base', baseDir), loadBundleLayer('@deepseek-ai/dsh-web-app', webDir),
        { packageName: approvedName, packageDir: approvedDir, patchPaths: [], patches: [] }],
    }
    const approvedPolicy = { ...policy, approvedBundles: [{ name: approvedName, version: '2.4.1' }] }
    const context = { name: 'desktop', dir: root, patchPath: profile.patchPath, installAnchor, home: root,
      cwd: root, startedBundles: profile.layers.map(item => item.packageName), overlays: [],
      telemetryDisabledEnv: undefined, enterprisePolicy: approvedPolicy }
    expect(() => readProfilePatches('test', context, profile)).not.toThrow()
    expect(() => readProfilePatches('test', { ...context, enterprisePolicy: policy }, profile))
      .toThrow('bundle list must match')

    writeFileSync(join(approvedDir, 'package.json'), JSON.stringify({ name: approvedName, version: '2.4.2' }))
    expect(() => readProfilePatches('test', context, profile)).toThrow('does not match its approved version')
    writeFileSync(join(approvedDir, 'package.json'), JSON.stringify({ name: approvedName, version: '2.4.1' }))

    const userBundleDir = join(root, 'user-bundles', 'dsh-approved-plugin')
    mkdirSync(userBundleDir, { recursive: true })
    writeFileSync(join(userBundleDir, 'package.json'), JSON.stringify({ name: approvedName, version: '2.4.1' }))
    const userBundle = { ...profile, layers: [...profile.layers.slice(0, 2),
      { packageName: approvedName, packageDir: userBundleDir, patchPaths: [], patches: [] }] }
    expect(() => readProfilePatches('test', context, userBundle))
      .toThrow('must come from the signed Desktop installation')
  })
})
