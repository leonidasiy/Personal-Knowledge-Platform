import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createLocalApplication } from './application.mjs';
import { seedWalkthrough } from './walkthrough-seed.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = 4180, origin = `http://localhost:${port}`;
// Public demo credential, valid only for this disposable loopback instance.
const password = 'resonance-walkthrough-only';
await access(join(root, 'dist/index.html')).catch(() => { throw new Error('Build the app first: deno task build'); });
const parent = join(root, '.private/walkthrough');
await mkdir(parent, { recursive: true, mode: 0o700 });
const dataDirectory = await mkdtemp(join(parent, 'session-'));
let application, server, closing = false;
async function close() {
  if (closing) return;
  closing = true;
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await application?.close();
  await rm(dataDirectory, { recursive: true });
}
try {
  application = await createLocalApplication({ root, dataDirectory, password, origin, port, environment: {}, fetch: async () => { throw new Error('Walkthrough external services are disabled.'); } });
  const summary = await seedWalkthrough(application.database);
  server = createServer(async (incoming, outgoing) => {
    try {
      const request = new Request(new URL(incoming.url ?? '/', origin), { method: incoming.method, headers: incoming.headers, body: ['GET', 'HEAD'].includes(incoming.method) ? undefined : Readable.toWeb(incoming), duplex: 'half' });
      const response = await application.fetch(request);
      let body = response.body;
      if (response.ok && incoming.method === 'GET' && response.headers.get('content-type')?.startsWith('text/html')) {
        const html = (await response.text()).replace('Use the password from your private .env.local file.', `Isolated walkthrough. Demo password: ${password}`).replace('<title>Resonance Learning</title>', '<title>Resonance Walkthrough</title>').replace('<body>', '<body><aside class="local-badge library-processing-status" aria-label="Walkthrough environment">Walkthrough library · synthetic activity · personal library untouched · external processing disabled</aside>');
        body = new Response(html).body;
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (body) Readable.fromWeb(body).pipe(outgoing); else outgoing.end();
    } catch (error) {
      console.error(JSON.stringify({ event: 'walkthrough-request-failure', message: error instanceof Error ? error.message : 'Unknown failure' }));
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'text/plain' });
      outgoing.end('The walkthrough request failed. Check the local terminal.');
    }
  });
  server.requestTimeout = 120_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  console.info(JSON.stringify({ event: 'walkthrough-ready', ...summary }));
  console.info(`Open ${origin}/#library\nDemo password: ${password}\nFresh sample data is generated on each start. Ctrl+C stops the server and removes its disposable database.`);
  process.once('SIGINT', () => { void close().then(() => process.exit(0)); });
  process.once('SIGTERM', () => { void close().then(() => process.exit(0)); });
} catch (error) { await close(); throw error; }
