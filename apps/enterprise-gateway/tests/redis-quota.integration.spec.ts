import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from 'redis'
import { afterAll, expect, it } from 'vitest'
import { createRedisConcurrencyLimiter } from '../src/concurrency-limiter.mjs'

const redisUrl = process.env.REDIS_URL
const fixture = fileURLToPath(new URL('./fixtures/redis-quota-worker.mjs', import.meta.url))
const children = new Set<ChildProcess>()

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  await Promise.all([...children].map(waitForChildExit))
})

it.skipIf(redisUrl === undefined)('enforces subject concurrency atomically across gateway processes', async () => {
  const subject = randomUUID()
  const workers = Array.from({ length: 8 }, (_, index) => startWorker({
    requestId: randomUUID(), subject, tenant: '', subjectLimit: 1, tenantLimit: 0, index,
  }))
  const results = await Promise.all(workers.map(worker => worker.result))
  expect(results.filter(result => result.acquired)).toHaveLength(1)
  expect(results.filter(result => !result.acquired).map(result => result.reason))
    .toEqual(Array(7).fill('subject_concurrency_limit'))
  await releaseWorkers(workers)

  const client = await redisClient()
  try {
    const next = await createRedisConcurrencyLimiter(client, 60_000).acquire({
      requestId: randomUUID(), subject, subjectLimit: 1, tenantLimit: 0,
    })
    expect('reason' in next).toBe(false)
    if (!('reason' in next)) await next.release()
  } finally {
    await client.close()
  }
})

it.skipIf(redisUrl === undefined)('enforces tenant concurrency across gateway processes with distinct subjects', async () => {
  const tenant = randomUUID()
  const workers = Array.from({ length: 5 }, (_, index) => startWorker({
    requestId: randomUUID(), subject: randomUUID(), tenant, subjectLimit: 3, tenantLimit: 1, index,
  }))
  const results = await Promise.all(workers.map(worker => worker.result))
  expect(results.filter(result => result.acquired)).toHaveLength(1)
  expect(results.filter(result => !result.acquired).map(result => result.reason))
    .toEqual(Array(4).fill('tenant_concurrency_limit'))
  await releaseWorkers(workers)
})

function startWorker(input: {
  requestId: string
  subject: string
  tenant: string
  subjectLimit: number
  tenantLimit: number
  index: number
}) {
  if (redisUrl === undefined) throw new Error('REDIS_URL is required for the Redis quota integration test')
  const child = spawn(process.execPath, [fixture, input.requestId, input.subject, input.tenant,
    String(input.subjectLimit), String(input.tenantLimit)], {
    env: { REDIS_URL: redisUrl },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.add(child)
  let output = ''
  const result = new Promise<{ acquired: boolean; reason?: string }>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      const lineEnd = output.indexOf('\n')
      if (lineEnd < 0) return
      try { resolve(JSON.parse(output.slice(0, lineEnd)) as { acquired: boolean; reason?: string }) }
      catch { reject(new Error(`Redis quota worker ${input.index} returned invalid output`)) }
    })
    child.once('error', reject)
    child.once('close', (code) => {
      children.delete(child)
      if (!output.includes('\n')) reject(new Error(`Redis quota worker ${input.index} exited before reporting (code ${String(code)})`))
    })
  })
  return { child, result }
}

async function releaseWorkers(workers: Array<{ child: ChildProcess; result: Promise<{ acquired: boolean }> }>): Promise<void> {
  for (const worker of workers) {
    const result = await worker.result
    if (result.acquired && worker.child.exitCode === null && worker.child.signalCode === null) {
      worker.child.stdin?.end('release\n')
    }
  }
  await Promise.all(workers.map(worker => waitForChildExit(worker.child)))
}

async function redisClient() {
  if (redisUrl === undefined) throw new Error('REDIS_URL is required for the Redis quota integration test')
  const client = createClient({ url: redisUrl })
  client.on('error', () => {})
  await client.connect()
  return client
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => { child.once('close', () => { children.delete(child); resolve() }) })
}
