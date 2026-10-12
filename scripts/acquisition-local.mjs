// @ts-check
import process from 'node:process';
import { isAbsolute } from 'node:path';
import { access } from 'node:fs/promises';
import { createAcquisitionRuntime } from '../acquisition/runtime.ts';
import { ACQUISITION_POLICY as policy } from '../worker/acquisition-policy.js';

// Local-only composition boundary; no source requests occur at startup.
const token = process.env.ACQUISITION_LOCAL_TOKEN;
if (typeof token !== 'string' || token.length < 12 || /[\r\n]/.test(token)) {
  throw new TypeError('ConfigurationInvalid: ACQUISITION_LOCAL_TOKEN');
}
const [chromePath, portText] = process.argv.slice(2);
if (typeof chromePath !== 'string' || !isAbsolute(chromePath)) {
  throw new TypeError('ConfigurationInvalid: absolute Chrome path');
}
if (typeof portText !== 'string' || !/^\d{1,5}$/.test(portText) || Number(portText) > 65535) {
  throw new TypeError('ConfigurationInvalid: port');
}
await access(chromePath);
const { server } = createAcquisitionRuntime({
  policy, tokens: new Map([[token, 'local-client']]), chromePath,
  nodePath: process.execPath, platform: process.platform, nowMs: Date.now,
  logger: entry => console.log(JSON.stringify(entry)),
  maximumActive: 2, maximumRetained: 100, retentionMilliseconds: 60_000,
  transport: { kind: 'loopback-fixture' },
});
server.listen(Number(portText), '127.0.0.1', () => {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('ConfigurationInvalid: listener');
  console.log(JSON.stringify({ event: 'acquisition-local-listening', host: address.address, port: address.port }));
});
