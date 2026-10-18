import process from 'node:process';
import sharp from 'sharp';

const [maximumBytes, maximumPixels, width, height] = process.argv.slice(2).map(Number);
if ([maximumBytes, maximumPixels, width, height].some(value => !Number.isSafeInteger(value) || value < 1)) process.exit(1);
sharp.concurrency(1);
sharp.cache(false);
try {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > maximumBytes) process.exit(1);
    chunks.push(chunk);
  }
  const image = sharp(Buffer.concat(chunks), { limitInputPixels: maximumPixels, failOn: 'warning', animated: false });
  const metadata = await image.metadata();
  if (metadata.width !== width || metadata.height !== height || (metadata.pages ?? 1) !== 1) process.exit(1);
  await image.stats();
} catch {
  process.exit(1);
}
