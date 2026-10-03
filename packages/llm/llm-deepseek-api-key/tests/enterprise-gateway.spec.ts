import { expect, it, vi } from 'vitest'
import { resolveEnterpriseAdapterOptions } from '../src/config.ts'
import { resolveProviderAuth } from '../src/auth.ts'

it('pins the managed model endpoint above a public provider setting', () => {
  const configured = { baseURL: 'https://api.deepseek.com/anthropic' }
  expect(resolveEnterpriseAdapterOptions(configured, undefined, 'https://gateway.example.test/anthropic').baseURL)
    .toBe('https://gateway.example.test/anthropic')
  expect(resolveEnterpriseAdapterOptions(configured, undefined, undefined).baseURL)
    .toBe('https://api.deepseek.com/anthropic')
})

it('uses a managed Bearer token without falling back to API-key credentials', async () => {
  const getAccessToken = vi.fn(async () => 'oidc-access-token')
  const getApiKey = vi.fn(async () => 'api-key')
  await expect(resolveProviderAuth(true, getAccessToken, getApiKey)).resolves.toEqual({
    headers: { Authorization: 'Bearer oidc-access-token' },
  })
  expect(getAccessToken).toHaveBeenCalledOnce()
  expect(getApiKey).not.toHaveBeenCalled()
})

it('requires enterprise sign-in for an OIDC-managed gateway', async () => {
  const getApiKey = vi.fn(async () => 'api-key')
  await expect(resolveProviderAuth(true, async () => undefined, getApiKey)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  expect(getApiKey).not.toHaveBeenCalled()
})

it('keeps API-key authentication for unmanaged provider routes', async () => {
  await expect(resolveProviderAuth(false, async () => 'unused', async () => 'api-key')).resolves.toEqual({
    headers: { 'x-api-key': 'api-key' },
  })
})
