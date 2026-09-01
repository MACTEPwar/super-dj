import { loadConfig } from './config/env';
import { buildServer } from './server';

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, prisma } = buildServer(config);

  await prisma.$connect();

  const server = app.listen(config.port, () => {
    console.log(`super-dj listening on port ${config.port}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await prisma.$disconnect();
    } catch (err) {
      console.error('error disconnecting from the database during shutdown', err);
    }
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown());
  process.on('SIGINT', () => shutdown());
}

main().catch((err) => {
  console.error('failed to start super-dj', err);
  process.exit(1);
});
