import { createClient } from 'redis'
import { createRedisConcurrencyLimiter } from '../../src/concurrency-limiter.mjs'

const [requestId, subject, rawTenant, rawSubjectLimit, rawTenantLimit] = process.argv.slice(2)
const url = process.env.REDIS_URL
if (url === undefined || requestId === undefined || subject === undefined
  || rawSubjectLimit === undefined || rawTenantLimit === undefined) {
  process.stderr.write('Redis quota worker configuration is incomplete\n')
  process.exit(2)
}

const client = createClient({ url, socket: { connectTimeout: 3000, reconnectStrategy: false }, disableOfflineQueue: true,
  commandOptions: { timeout: 3000 } })
client.on('error', () => {})
try {
  await client.connect()
  const tenantLimit = Number(rawTenantLimit)
  const lease = await createRedisConcurrencyLimiter(client, 60_000).acquire({
    requestId, subject, ...(rawTenant === '' ? {} : { tenant: rawTenant }),
    subjectLimit: Number(rawSubjectLimit), tenantLimit,
  })
  process.stdout.write(`${JSON.stringify('reason' in lease ? { acquired: false, reason: lease.reason } : { acquired: true })}\n`)
  if ('reason' in lease) await client.close()
  else process.stdin.once('data', async () => {
    await lease.release()
    await client.close()
  })
} catch {
  process.stderr.write('Redis quota worker could not reach the shared store\n')
  client.destroy()
  process.exitCode = 1
}
