import { loadConfig } from './config/env';
import { buildServer } from './server';

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, library, queue } = buildServer(config);

  await library.scan();
  queue.setTracks(library.list());

  app.listen(config.port, () => {
    console.log(`super-dj listening on port ${config.port}`);
  });
}

main().catch((err) => {
  console.error('failed to start super-dj', err);
  process.exit(1);
});
