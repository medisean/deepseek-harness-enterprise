import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { afterEach, expect, it, vi } from 'vitest'
import * as ApiKey from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function managedProfile(): ProfileContext {
  return {
    name: 'desktop', dir: '/app/profile', patchPath: '/app/profile/cordis.patch.yml',
    installAnchor: '/app/DeepSeek Harness/package.json', cwd: '/workspace', home: '/home/alice',
    startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
    enterprisePolicy: {
      version: 1, modelGateway: 'https://gateway.example.test/v1', workspaceMode: 'read-only',
      workspaceRoot: '/workspace',
      oidc: {
        issuer: 'https://id.example.test', clientId: 'desktop-client', gatewayScope: 'model:invoke',
        scopes: ['openid', 'model:invoke'], audience: 'enterprise-gateway',
      },
    },
  }
}

async function runOneRequest(ctx: Context): Promise<void> {
  for await (const _chunk of ctx.llm.stream({
    provider: 'deepseek-official', model: 'deepseek-v4-flash',
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })],
  })) { /* drain the failed gateway response */ }
}

it('routes unmanaged requests with an API key through the registered provider auth callback', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-api-key')
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unavailable', { status: 503 }))
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ApiKey, { baseURL: 'https://provider.example.test/v1' })

  await runOneRequest(ctx)
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('x-api-key')).toBe('test-api-key')
})

it('routes managed requests with OIDC and never falls back to the launching API key', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'must-not-be-used')
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unavailable', { status: 503 }))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('profileContext', managedProfile())
  ctx.enterpriseAuth = { getAccessToken: async () => 'managed-access-token' }
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ApiKey, { baseURL: 'https://provider.example.test/v1' })

  await runOneRequest(ctx)
  const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers)
  expect(headers.get('authorization')).toBe('Bearer managed-access-token')
  expect(headers.has('x-api-key')).toBe(false)
})

it('fails closed when managed OIDC has no access token or Host auth provider', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'must-not-be-used')
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unexpected request', { status: 503 }))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('profileContext', managedProfile())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ApiKey, { baseURL: 'https://provider.example.test/v1' })

  await runOneRequest(ctx).catch(() => undefined)
  expect(fetch).not.toHaveBeenCalled()
})
