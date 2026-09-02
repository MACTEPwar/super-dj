import { Router } from 'express';
import { ApiError } from '../errors';
import { wrapAsync } from '../api/errorHandler';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { AuthService } from '../auth/authService';
import { OAuthProviderAdapter } from './oauthProviderAdapter';
import { OAuthStateRepository } from './oauthStateRepository';
import { OAuthConnectionRepository } from './oauthConnectionRepository';
import { DestinationRepository } from './destinationRepository';
import { encrypt } from '../crypto/streamKeyCipher';

const STATE_TTL_MINUTES = 10;

export function createOAuthRouter(
  authService: AuthService,
  adapters: Record<string, OAuthProviderAdapter>,
  oauthStateRepository: Pick<OAuthStateRepository, 'create' | 'findValid' | 'deleteById'>,
  oauthConnectionRepository: Pick<OAuthConnectionRepository, 'create'>,
  destinationRepository: Pick<DestinationRepository, 'create'>,
  encryptionKey: string,
): Router {
  const router = Router();
  const auth = requireAuth(authService);

  router.get('/:provider/oauth/start', auth, wrapAsync(async (req, res) => {
    const adapter = adapters[req.params.provider];
    if (!adapter) throw new ApiError(404, `unknown provider: ${req.params.provider}`);

    const expiresAt = new Date(Date.now() + STATE_TTL_MINUTES * 60 * 1000);
    const state = await oauthStateRepository.create((req as AuthenticatedRequest).user!.id, adapter.provider, expiresAt);
    res.status(200).json({ authUrl: adapter.buildAuthUrl(state.id) });
  }));

  router.get('/:provider/oauth/callback', wrapAsync(async (req, res) => {
    const adapter = adapters[req.params.provider];
    if (!adapter) throw new ApiError(404, `unknown provider: ${req.params.provider}`);

    const { code, state: stateId } = req.query;
    if (typeof code !== 'string' || code.length === 0) throw new ApiError(400, 'query.code is required');
    if (typeof stateId !== 'string' || stateId.length === 0) throw new ApiError(400, 'query.state is required');

    const state = await oauthStateRepository.findValid(stateId, adapter.provider, new Date());
    if (!state) throw new ApiError(400, 'invalid or expired oauth state');
    await oauthStateRepository.deleteById(state.id);

    const tokens = await adapter.exchangeCode(code);
    const identity = await adapter.fetchAccountIdentity(tokens.accessToken);

    const destination = await destinationRepository.create({
      userId: state.userId, name: identity.externalAccountName, provider: adapter.provider, rtmpUrl: null, streamKeyEncrypted: null,
    });
    await oauthConnectionRepository.create({
      destinationId: destination.id,
      provider: adapter.provider,
      externalAccountId: identity.externalAccountId,
      externalAccountName: identity.externalAccountName,
      refreshTokenEncrypted: encrypt(tokens.refreshToken, encryptionKey),
    });

    res.status(200).send(`
<html><body>
  Connected — this tab will close automatically.
  <script>
    if (window.opener) { window.opener.postMessage('super-dj-oauth-connected', '*'); }
    window.close();
  </script>
</body></html>`.trim());
  }));

  return router;
}
