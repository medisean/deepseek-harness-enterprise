import { expect, it } from 'vitest'
import { resolveEnterpriseAdapterOptions } from '../src/config.ts'

it('pins the managed model endpoint above a public provider setting', () => {
  const configured = { baseURL: 'https://api.deepseek.com/anthropic' }
  expect(resolveEnterpriseAdapterOptions(configured, undefined, 'https://gateway.example.test/anthropic').baseURL)
    .toBe('https://gateway.example.test/anthropic')
  expect(resolveEnterpriseAdapterOptions(configured, undefined, undefined).baseURL)
    .toBe('https://api.deepseek.com/anthropic')
})
