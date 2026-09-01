export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface OAuthAccountIdentity {
  externalAccountId: string;
  externalAccountName: string;
}

export interface OAuthProviderAdapter {
  readonly provider: string;
  buildAuthUrl(state: string): string;
  exchangeCode(code: string): Promise<OAuthTokens>;
  fetchAccountIdentity(accessToken: string): Promise<OAuthAccountIdentity>;
  revoke(refreshToken: string): Promise<void>;
}
