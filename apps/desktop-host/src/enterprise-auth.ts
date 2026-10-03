/** Private IPC bridge for per-request enterprise access-token resolution. */
import type { Context } from '@deepseek-ai/cordis'

interface TokenResponse {
  readonly type: 'enterprise-token-response'
  readonly requestId: number
  readonly token?: string
}

const pending = new Map<number, {
  readonly resolve: (token: string | undefined) => void
  readonly timer: ReturnType<typeof setTimeout>
}>()
let nextRequestId = 1

function receive(message: unknown): void {
  if (typeof message !== 'object' || message === null || !('type' in message)
    || message.type !== 'enterprise-token-response' || !('requestId' in message)
    || !Number.isSafeInteger(message.requestId)) return
  const response = message as TokenResponse
  if (response.token !== undefined && (typeof response.token !== 'string' || response.token.length === 0
    || response.token.length > 64 * 1024)) return
  const request = pending.get(response.requestId)
  if (request === undefined) return
  pending.delete(response.requestId)
  clearTimeout(request.timer)
  request.resolve(response.token)
}

/** Install the Host-only access-token callback used by the managed model adapter.
 * @param ctx - profile context receiving the private provider.
 */
export function installEnterpriseAuthBridge(ctx: Context): void {
  process.on('message', receive)
  ctx.enterpriseAuth = { getAccessToken: requestAccessToken }
}

function requestAccessToken(): Promise<string | undefined> {
  if (!process.connected || process.send === undefined) return Promise.resolve(undefined)
  const requestId = nextRequestId++
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      resolve(undefined)
    }, 30_000)
    timer.unref()
    pending.set(requestId, { resolve, timer })
    process.send?.({ type: 'enterprise-token-request', requestId }, (error) => {
      if (error === null) return
      const request = pending.get(requestId)
      if (request === undefined) return
      pending.delete(requestId)
      clearTimeout(request.timer)
      request.resolve(undefined)
    })
  })
}
