// Puts General Sans into public/fonts/ so the dashboard serves it from its own origin and loads nothing from Fontshare.
//
// Why a download and not a committed file: General Sans is under the ITF Free Font License (FFL), which allows
// self-hosting on your own site but not redistributing the font files through a repository. So each checkout gets
// its own copy straight from Fontshare at build time (with the license next to it), and git ignores the files
// (public/fonts/.gitignore). IBM Plex Mono is OFL and is committed.
//
// Runs before `npm run dev` and `npm run build`. Does nothing when the files are already there. Never fails the
// build: without network the dashboard falls back to the system sans, still with no third-party request.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fonts');
const ZIP = 'https://api.fontshare.com/v2/fonts/download/general-sans';
const WANT = {
  'GeneralSans_Complete/Fonts/WEB/fonts/GeneralSans-Regular.woff2': 'GeneralSans-Regular.woff2',
  'GeneralSans_Complete/Fonts/WEB/fonts/GeneralSans-Medium.woff2': 'GeneralSans-Medium.woff2',
  'GeneralSans_Complete/Fonts/WEB/fonts/GeneralSans-Semibold.woff2': 'GeneralSans-Semibold.woff2',
  'GeneralSans_Complete/Fonts/WEB/fonts/GeneralSans-Bold.woff2': 'GeneralSans-Bold.woff2',
  'GeneralSans_Complete/License/FFL.txt': 'GeneralSans-FFL.txt',
};

// The exact files we use. A different download is refused, whatever it contains: check it by hand, then update these.
const SHA256 = {
  'GeneralSans-Regular.woff2': '1336dc6137440a94f87d883bcc3ee26bdbd580606d61e89e6e530757d9328886',
  'GeneralSans-Medium.woff2': '0168813e5da4bb7fcbffbe1305cc4932220772ff26c0488c5d62e28f579aa5ae',
  'GeneralSans-Semibold.woff2': '225c2c18bd1cebdd9c4aedc07201d5a5fd086f44d5418c09bce308a0832ccfcf',
  'GeneralSans-Bold.woff2': '0bb4361798c57a448ca3bb9aa251b5a2290f6d79b006edd4161e1962d0eafa26',
  'GeneralSans-FFL.txt': '145e7fe2429a3336ba215c070ef722000e01348a3e1baaa127e871bb5012f554',
};
const MAX_ZIP = 20_000_000;
const MAX_FILE = 200_000;

if (Object.values(WANT).every((f) => existsSync(join(out, f)))) process.exit(0);

/** The few entries we need from a zip, read through its central directory. */
function unzip(buf, names) {
  const files = {};
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (names.includes(name)) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      files[name] = method === 0 ? data : inflateRawSync(data, { maxOutputLength: MAX_FILE });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** The response body, refused once it passes `max` bytes. */
async function readCapped(res, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > max) throw new Error(`the download is larger than ${max} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

try {
  const res = await fetch(ZIP, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Fontshare answered ${res.status}`);
  const files = unzip(await readCapped(res, MAX_ZIP), Object.keys(WANT));
  const missing = Object.keys(WANT).filter((k) => !files[k]);
  if (missing.length) throw new Error(`not in the download: ${missing.join(', ')}`);
  const changed = Object.entries(WANT).filter(([from, to]) => createHash('sha256').update(files[from]).digest('hex') !== SHA256[to]);
  if (changed.length) throw new Error(`not the expected files: ${changed.map(([, to]) => to).join(', ')}`);
  mkdirSync(out, { recursive: true });
  for (const [from, to] of Object.entries(WANT)) writeFileSync(join(out, to), files[from]);
  console.log('fetch-fonts: General Sans saved to public/fonts (ITF Free Font License, see GeneralSans-FFL.txt)');
} catch (e) {
  console.warn(`fetch-fonts: could not get General Sans (${e.message}); the dashboard will use the system sans.`);
}
