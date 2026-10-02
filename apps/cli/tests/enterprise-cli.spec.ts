import { expect, it } from 'vitest'
import { runCli } from '../src/bin.ts'

const policy = { version: 1 as const, modelGateway: 'https://gateway.example.test/anthropic',
  workspaceMode: 'read-only' as const, workspaceRoot: '/approved' }

it.each([
  ['plugin', '--profile', 'desktop', 'add', 'unapproved@1.0.0'],
  ['web'],
])('the packaged managed CLI refuses %j', async (...args: string[]) => {
  const original = process.argv
  try {
    process.argv = ['node', 'dsh', ...args]
    await expect(runCli({ enterprisePolicy: policy, manageDesktopProfile: true })).rejects.toThrow('managed Desktop profile only')
  } finally {
    process.argv = original
  }
})
