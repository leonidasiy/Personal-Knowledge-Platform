// @ts-check
import process from 'node:process';
import { createAcquisitionDeployment } from '../acquisition/deployment.ts';

try {
  // Loading the native decoder at startup reports unsupported installations before serving.
  await import('sharp');
  const runtime = await createAcquisitionDeployment({
    env: process.env, nodePath: process.execPath, platform: process.platform,
    logger: entry => console.log(JSON.stringify(entry)),
  });
  await new Promise((resolve, reject) => {
    runtime.server.once('error', reject);
    runtime.server.listen(runtime.port, runtime.host, () => resolve(null));
  });
  console.log(JSON.stringify({ event: 'acquisition-listening', host: runtime.host, port: runtime.port, transport: runtime.mode }));
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    console.log(JSON.stringify({ event: 'acquisition-stopping' }));
    const timeout = setTimeout(() => runtime.server.closeAllConnections(), 31_000);
    runtime.server.close(() => { clearTimeout(timeout); });
    runtime.server.closeIdleConnections();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  const message = error instanceof TypeError && error.message.startsWith('ConfigurationInvalid:')
    ? error.message
    : 'Acquisition startup failed; check installed dependencies, file permissions, TLS files and listener availability.';
  console.error(JSON.stringify({ event: 'acquisition-startup-failed', message }));
  process.exitCode = 1;
}
