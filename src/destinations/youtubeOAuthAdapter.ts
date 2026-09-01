import { YoutubeApiClient } from './youtubeApiClient';
import { OAuthAccountIdentity, OAuthProviderAdapter, OAuthTokens } from './oauthProviderAdapter';

export interface YoutubeOAuthAdapterDeps {
  client: YoutubeApiClient;
  clientId: string;
  redirectUri: string;
  scope: string;
}

export class YoutubeOAuthAdapter implements OAuthProviderAdapter {
  readonly provider = 'youtube';

  constructor(private readonly deps: YoutubeOAuthAdapterDeps) {}

  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.deps.clientId,
      redirect_uri: this.deps.redirectUri,
      response_type: 'code',
      scope: this.deps.scope,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  exchangeCode(code: string): Promise<OAuthTokens> {
    return this.deps.client.exchangeCode(code, this.deps.redirectUri);
  }

  async fetchAccountIdentity(accessToken: string): Promise<OAuthAccountIdentity> {
    const channel = await this.deps.client.getChannel(accessToken);
    return { externalAccountId: channel.id, externalAccountName: channel.title };
  }

  revoke(refreshToken: string): Promise<void> {
    return this.deps.client.revoke(refreshToken);
  }
}
