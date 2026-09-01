import { StreamDestination } from '@prisma/client';
import { ApiError } from '../errors';
import { decrypt } from '../crypto/streamKeyCipher';
import { BroadcastMeta, PreparedSession, StreamDestinationProvider } from './streamDestinationProvider';

export class CustomRtmpProvider implements StreamDestinationProvider {
  constructor(private readonly encryptionKey: string) {}

  async prepareSession(destination: StreamDestination, _meta: BroadcastMeta): Promise<PreparedSession> {
    if (!destination.rtmpUrl || !destination.streamKeyEncrypted) {
      throw new ApiError(500, 'custom destination is missing rtmpUrl/streamKey');
    }
    return {
      rtmpUrl: destination.rtmpUrl,
      streamKey: decrypt(destination.streamKeyEncrypted, this.encryptionKey),
    };
  }
}
