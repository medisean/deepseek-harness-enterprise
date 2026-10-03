import { createHash } from 'node:crypto'

const ACQUIRE_SCRIPT = `
local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local expiry = now + tonumber(ARGV[2])
local subjectLimit = tonumber(ARGV[3])
local tenantLimit = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if #KEYS == 2 then redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now) end
if redis.call('ZCARD', KEYS[1]) >= subjectLimit then return -1 end
if tenantLimit > 0 and redis.call('ZCARD', KEYS[2]) >= tenantLimit then return -2 end
redis.call('ZADD', KEYS[1], expiry, ARGV[1])
redis.call('PEXPIRE', KEYS[1], expiry - now + 1000)
if tenantLimit > 0 then
  redis.call('ZADD', KEYS[2], expiry, ARGV[1])
  redis.call('PEXPIRE', KEYS[2], expiry - now + 1000)
end
return 1
`

const RELEASE_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`

/** Create the per-process fallback used for development and single-instance deployments. */
export function createLocalConcurrencyLimiter() {
  const subjects = new Map()
  const tenants = new Map()
  return {
    isReady: () => true,
    async acquire({ subject, tenant, subjectLimit, tenantLimit }) {
      const activeSubject = subjects.get(subject) ?? 0
      if (activeSubject >= subjectLimit) return { reason: 'subject_concurrency_limit' }
      const activeTenant = tenant === undefined ? 0 : tenants.get(tenant) ?? 0
      if (tenantLimit > 0 && activeTenant >= tenantLimit) return { reason: 'tenant_concurrency_limit' }
      subjects.set(subject, activeSubject + 1)
      if (tenantLimit > 0 && tenant !== undefined) tenants.set(tenant, activeTenant + 1)
      let released = false
      return {
        release: async () => {
          if (released) return
          released = true
          decrement(subjects, subject)
          if (tenantLimit > 0 && tenant !== undefined) decrement(tenants, tenant)
        },
      }
    },
  }
}

/** Create an atomic cross-replica limiter backed by a shared Redis deployment. */
export function createRedisConcurrencyLimiter(client, leaseMs) {
  return {
    isReady: () => client.isReady,
    async acquire({ requestId, subject, tenant, subjectLimit, tenantLimit }) {
      const subjectKey = `dsh-egw:{concurrency}:subject:${digest(subject)}`
      const keys = [subjectKey]
      if (tenantLimit > 0 && tenant !== undefined) keys.push(`dsh-egw:{concurrency}:tenant:${digest(tenant)}`)
      const result = Number(await client.eval(ACQUIRE_SCRIPT, {
        keys,
        arguments: [requestId, String(leaseMs), String(subjectLimit), String(tenantLimit)],
      }))
      if (result === -1) return { reason: 'subject_concurrency_limit' }
      if (result === -2) return { reason: 'tenant_concurrency_limit' }
      if (result !== 1) throw new Error('enterprise gateway: unexpected concurrency lease result')
      let released = false
      return {
        release: async () => {
          if (released) return
          released = true
          await client.eval(RELEASE_SCRIPT, {
            keys: [subjectKey, keys[1] ?? subjectKey],
            arguments: [requestId],
          })
        },
      }
    },
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest('base64url')
}

function decrement(values, key) {
  const active = values.get(key) ?? 1
  if (active <= 1) values.delete(key)
  else values.set(key, active - 1)
}
