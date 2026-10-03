/** Host-owned access to managed enterprise model credentials. */
/** Access-token provider exposed only to in-process model adapters. */
export interface EnterpriseAuthProvider {
  /** @returns a current access token, or undefined when the user must sign in. */
  getAccessToken(): Promise<string | undefined>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional private bridge to Desktop's operating-system-protected SSO session. */
    enterpriseAuth?: EnterpriseAuthProvider
  }
}
