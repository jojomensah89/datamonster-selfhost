// Renders the social share card (public/og-image.png) from scripts/og-image.html, and on request the app icons
// from Spike in public/favicon.svg. Uses an installed Chrome, Edge or Chromium in headless mode; nothing to npm install.
//
//   node scripts/make-icons.mjs                 share card only
//   node scripts/make-icons.mjs --icons         share card, plus the PNG icons and favicon.ico redrawn from public/favicon.svg
//   node scripts/make-icons.mjs --out <dir>     write into <dir> instead of public/ (to preview without touching it)
//
// public/favicon.svg (Spike) is the source of every icon and is never written here.
// Set CHROME=/path/to/browser when the browser is not in a usual place.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const out = outArg >= 0 ? resolve(args[outArg + 1]) : join(root, 'public');
const withIcons = args.includes('--icons');
mkdirSync(out, { recursive: true });

const browser = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p) => p && existsSync(p));
if (!browser) throw new Error('No Chrome, Edge or Chromium found. Set CHROME=/path/to/browser.');

/** Screenshot a page at an exact size. */
function shoot(url, w, h, file) {
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--allow-file-access-from-files', '--virtual-time-budget=3000', '--default-background-color=00000000',
    `--window-size=${w},${h}`, `--screenshot=${file}`, url,
  ], { stdio: 'ignore' });
  if (!existsSync(file)) throw new Error(`The browser did not write ${file}`);
}

shoot(pathToFileURL(join(root, 'scripts/og-image.html')).href, 1200, 630, join(out, 'og-image.png'));
console.log('og-image.png');

if (withIcons) {
  // Spike centred on white with a margin, as the shipped icons are. iOS rounds the touch icon's corners itself.
  const svg = readFileSync(join(root, 'public/favicon.svg'), 'utf8').replace(/<\?xml[^>]*>/, '');
  const tmp = mkdtempSync(join(tmpdir(), 'dm-icons-'));
  const page = (n) => {
    const file = join(tmp, `icon-${n}.html`);
    writeFileSync(file, `<!doctype html><html><body style="margin:0;width:${n}px;height:${n}px;overflow:hidden;background:#fff;display:grid;place-items:center">
      <div style="width:84%;height:84%">${svg.replace(/width="\d+" height="\d+"/, 'width="100%" height="100%"')}</div></body></html>`);
    return pathToFileURL(file).href;
  };
  const png = (n, name) => {
    const file = join(out, name);
    shoot(page(n), n, n, file);
    console.log(name);
    return readFileSync(file);
  };
  png(180, 'apple-touch-icon.png');
  png(192, 'icon-192.png');
  png(512, 'icon-512.png');
  png(32, 'favicon-32x32.png');
  png(48, 'favicon-48x48.png');

  // favicon.ico: browsers and crawlers request it directly. Holds PNG frames at 16, 32 and 48px.
  const sizes = [16, 32, 48];
  const frames = sizes.map((n) => {
    const file = join(tmp, `ico-${n}.png`);
    shoot(page(n), n, n, file);
    return readFileSync(file);
  });
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((buf, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(sizes[i], e);
    header.writeUInt8(sizes[i], e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(buf.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += buf.length;
  });
  writeFileSync(join(out, 'favicon.ico'), Buffer.concat([header, ...frames]));
  console.log('favicon.ico');
  rmSync(tmp, { recursive: true, force: true });
}
console.log('done');
