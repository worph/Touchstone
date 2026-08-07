import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import registerRoutes from './routes/index.js';
import { buildIndex } from './store/index.js';
import { resolveDataDir } from './store/config.js';

const PORT = Number(process.env.TOUCHSTONE_PORT ?? 8080);
const HOST = process.env.TOUCHSTONE_HOST ?? '0.0.0.0';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

// The index is the entire data layer: scan the archive, parse frontmatter, hold it in
// memory. `state/index.json` only makes a restart cheaper — deleting it is always safe.
const dataDir = resolveDataDir(process.env.TOUCHSTONE_DATA_DIR);
const reportsRoot = join(dataDir, 'reports');
const store = await buildIndex(reportsRoot, {
  onError: (file, err) => app.log.warn({ file, err }, 'unreadable report, skipped'),
});
app.log.info(
  { subjects: store.subjects().length, assays: store.all().length, broken: store.broken.length },
  'index built',
);

await app.register(registerRoutes, { prefix: '/api/v1', store });

// In production the built SPA sits next to the compiled server. In dev, Vite serves it
// instead and proxies /api here, so a missing dist/web is expected and not an error.
const webRoot = fileURLToPath(new URL('../web', import.meta.url));
if (existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

app.listen({ port: PORT, host: HOST }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
