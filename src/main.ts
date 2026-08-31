import { loadConfig } from './config/env';
import { buildServer } from './server';

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, library, queue, streamController, prisma } = buildServer(config);

  await prisma.$connect();
  await library.scan();
  queue.setTracks(library.list());

  const server = app.listen(config.port, () => {
    console.log(`super-dj listening on port ${config.port}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}, shutting down`);
    try {
      if (streamController.status().state !== 'idle') {
        streamController.stop();
      }
    } catch (err) {
      console.error('error stopping stream during shutdown', err);
    }
    await prisma.$disconnect();
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('failed to start super-dj', err);
  process.exit(1);
});
