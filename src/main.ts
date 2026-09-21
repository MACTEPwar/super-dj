import { loadConfig } from './config/env';
import { buildServer } from './server';

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, prisma, mediaMtxAuthApp, mediaMtxAuthPort, tempFileCleanupSweep } = buildServer(config);

  await prisma.$connect();

  const server = app.listen(config.port, () => {
    console.log(`super-dj listening on port ${config.port}`);
  });

  // Deliberately a second listener on its own port, which docker-compose never publishes: only
  // MediaMTX (by compose service name) can reach it. See src/stream/mediaMtxAuth.ts.
  const authServer = mediaMtxAuthApp.listen(mediaMtxAuthPort, () => {
    console.log(`super-dj mediamtx auth endpoint listening on port ${mediaMtxAuthPort}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    tempFileCleanupSweep.stop();
    try {
      await prisma.$disconnect();
    } catch (err) {
      console.error('error disconnecting from the database during shutdown', err);
    }
    authServer.close();
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown());
  process.on('SIGINT', () => shutdown());
}

main().catch((err) => {
  console.error('failed to start super-dj', err);
  process.exit(1);
});
