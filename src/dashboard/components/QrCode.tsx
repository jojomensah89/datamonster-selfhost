import qrcode from 'qrcode-generator';

const QUIET_ZONE = 4;
const MIN_PNG_PX = 1024;

// The encoder defaults to Latin-1 bytes; QR readers expect UTF-8 for byte mode.
qrcode.stringToBytes = (s: string) => Array.from(new TextEncoder().encode(s));

type Matrix = { count: number; dark: (row: number, col: number) => boolean };

/** Encodes with error correction M. Returns null when the value is too long to fit. */
function encode(value: string): Matrix | null {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(value, 'Byte');
    qr.make();
    return { count: qr.getModuleCount(), dark: (r, c) => qr.isDark(r, c) };
  } catch {
    return null;
  }
}

function modulePath(m: Matrix): string {
  let d = '';
  for (let r = 0; r < m.count; r++) {
    let c = 0;
    while (c < m.count) {
      if (!m.dark(r, c)) { c++; continue; }
      const start = c;
      while (c < m.count && m.dark(r, c)) c++;
      d += `M${start + QUIET_ZONE} ${r + QUIET_ZONE}h${c - start}v1h-${c - start}z`;
    }
  }
  return d;
}

function svgMarkup(m: Matrix, size?: number, label?: string): string {
  const total = m.count + QUIET_ZONE * 2;
  const dim = size ? ` width="${size}" height="${size}"` : '';
  const title = label ? `<title>${label.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}"${dim} shape-rendering="crispEdges">${title}<rect width="${total}" height="${total}" fill="#fff"/><path d="${modulePath(m)}" fill="#000"/></svg>`;
}

export function QrCode(props: { value: string; size?: number; label?: string }): JSX.Element {
  const { value, size = 192, label = `QR code for ${props.value}` } = props;
  const m = encode(value);
  if (!m) {
    return (
      <div role="img" aria-label="QR code unavailable" style={{ width: size, minHeight: size }}
        className="flex items-center justify-center rounded-md border border-dashed p-3 text-center text-sm">
        This link is too long to fit in a QR code. Use a shorter link.
      </div>
    );
  }
  const total = m.count + QUIET_ZONE * 2;
  return (
    <svg role="img" aria-label={label} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${total} ${total}`}
      width={size} height={size} shapeRendering="crispEdges" style={{ display: 'block', background: '#fff' }}>
      <rect width={total} height={total} fill="#fff" />
      <path d={modulePath(m)} fill="#000" />
    </svg>
  );
}

function safeFilename(name: string, ext: string): string {
  const base = name
    .replace(/\.(svg|png)$/i, '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return `${base || 'qr-code'}.${ext}`;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Deferred so the browser has started the download before the URL goes away.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export async function downloadQr(value: string, filename: string, format: 'svg' | 'png'): Promise<void> {
  const m = encode(value);
  if (!m) throw new Error('This link is too long to fit in a QR code.');
  const name = safeFilename(filename, format);
  if (format === 'svg') {
    saveBlob(new Blob([svgMarkup(m)], { type: 'image/svg+xml' }), name);
    return;
  }
  const total = m.count + QUIET_ZONE * 2;
  const scale = Math.ceil(MIN_PNG_PX / total); // whole pixels per module keeps edges crisp
  const px = total * scale;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create the PNG: canvas is not available in this browser.');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000';
  for (let r = 0; r < m.count; r++) {
    for (let c = 0; c < m.count; c++) {
      if (m.dark(r, c)) ctx.fillRect((c + QUIET_ZONE) * scale, (r + QUIET_ZONE) * scale, scale, scale);
    }
  }
  const blob = await new Promise<Blob | null>(resolve => {
    try { canvas.toBlob(resolve, 'image/png'); } catch { resolve(null); }
  });
  if (!blob) throw new Error('Could not create the PNG. Download the SVG instead.');
  saveBlob(blob, name);
}
