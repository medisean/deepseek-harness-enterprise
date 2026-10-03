/** Authentication headers for API-key and managed OIDC routes. */
import { LlmError } from '@deepseek-ai/dsh-llm'

/** Resolve the route's sole accepted authentication mode.
 * @param oidcRequired - whether machine policy requires enterprise SSO.
 * @param getAccessToken - private token provider for a managed Desktop session.
 * @param getApiKey - credential resolver for the unmanaged API-key route.
 * @returns request headers for the selected route.
 */
export async function resolveProviderAuth(
  oidcRequired: boolean,
  getAccessToken: () => Promise<string | undefined>,
  getApiKey: () => Promise<string>,
): Promise<{ headers: Record<string, string> }> {
  if (!oidcRequired) return { headers: { 'x-api-key': await getApiKey() } }
  const token = await getAccessToken()
  if (token === undefined) {
    throw new LlmError('llm-deepseek: enterprise sign-in is required for the managed gateway', 'MISSING_CREDENTIAL')
  }
  return { headers: { Authorization: `Bearer ${token}` } }
}
