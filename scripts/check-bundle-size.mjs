import { existsSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distDir = resolve(projectRoot, 'dist');
const indexPath = resolve(distDir, 'index.html');
const baselinePath = resolve(projectRoot, 'performance', 'bundle-baseline.json');

if (!existsSync(indexPath)) {
  console.error('Bundle budget: dist/index.html is missing. Run `npm run build` first.');
  process.exit(1);
}

const html = readFileSync(indexPath, 'utf8');
const entryFiles = new Set();
const assetPattern = /(?:src|href)=["']\/?(assets\/[^"']+)["']/g;
for (const match of html.matchAll(assetPattern)) {
  if (/\.m?js$/i.test(match[1])) entryFiles.add(match[1]);
}

if (entryFiles.size === 0) {
  console.error('Bundle budget: no JavaScript entry was found in dist/index.html.');
  process.exit(1);
}

let totalBytes = 0;
for (const relative of entryFiles) {
  // `relative` comes from URL-style HTML attributes. Keep it as a POSIX
  // relative path and let Node resolve it for the current runner; replacing
  // separators with `\\` breaks the Linux quality job.
  const assetPath = resolve(distDir, relative);
  if (!existsSync(assetPath) || !statSync(assetPath).isFile()) {
    console.error(`Bundle budget: referenced asset is missing: ${relative}`);
    process.exit(1);
  }
  const compressedBytes = gzipSync(readFileSync(assetPath), { level: 9 }).byteLength;
  totalBytes += compressedBytes;
  console.log(`Bundle budget: ${basename(assetPath)} ${(compressedBytes / 1024).toFixed(1)} KiB gzip`);
}

let baselineBytes = 0;
if (existsSync(baselinePath)) {
  try {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    baselineBytes = Number(baseline.initialJsGzipBytes) || 0;
  } catch {
    console.warn('Bundle budget: invalid baseline; using the explicit limit instead.');
  }
}

const explicitLimit = Number(process.env.MAX_INITIAL_JS_GZIP_KB || 520) * 1024;
const allowedBytes = baselineBytes > 0 ? Math.min(explicitLimit, Math.ceil(baselineBytes * 1.1)) : explicitLimit;
console.log(`Bundle budget: initial JavaScript ${(totalBytes / 1024).toFixed(1)} KiB gzip (limit ${(allowedBytes / 1024).toFixed(1)} KiB)`);

if (totalBytes > allowedBytes) {
  console.error('Bundle budget: initial JavaScript exceeded the allowed regression.');
  process.exit(1);
}
