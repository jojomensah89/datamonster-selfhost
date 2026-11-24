import { FLAT_LAND, GLOBE_LAND } from '../../assets/land-dots';

/** Land dots as [lon, lat] pairs, decoded once from the run-length rows in assets/land-dots.ts. */
function decode(encoded: string): Float32Array {
  const out: number[] = [];
  for (const row of encoded.split('|')) {
    const [lat, cells, runs] = row.split(':');
    const n = Number(cells);
    const r = runs.split(',').map(Number);
    for (let i = 0; i < r.length; i += 2) for (let c = r[i]; c < r[i] + r[i + 1]; c++) out.push(-180 + ((c + 0.5) * 360) / n, Number(lat));
  }
  return Float32Array.from(out);
}
let globeDots: Float32Array | null = null;
let flatDots: Float32Array | null = null;
export const landDots = (mode: MapMode) => (mode === 'globe' ? (globeDots ??= decode(GLOBE_LAND)) : (flatDots ??= decode(FLAT_LAND)));

export type MapMode = 'globe' | 'flat';
const RAD = Math.PI / 180;

/** Where the globe faces: the longitude and latitude at its centre, in degrees. */
export interface View {
  lon: number;
  lat: number;
}

export interface Frame {
  w: number;
  h: number;
  /** Globe: centre and radius. Flat: the map's box. */
  cx: number;
  cy: number;
  r: number;
  x0: number;
  y0: number;
  mw: number;
  mh: number;
}

// The flat map's latitude band (Antarctica and the far north add nothing to a visitor map).
export const FLAT_NORTH = 82;
export const FLAT_SOUTH = -56;

export function frameFor(mode: MapMode, w: number, h: number, pad = 8): Frame {
  const r = Math.max(10, Math.min(w, h) / 2 - pad);
  const aspect = 360 / (FLAT_NORTH - FLAT_SOUTH);
  let mw = w - pad * 2;
  let mh = mw / aspect;
  if (mh > h - pad * 2) {
    mh = h - pad * 2;
    mw = mh * aspect;
  }
  return { w, h, cx: w / 2, cy: h / 2, r: mode === 'globe' ? r : 0, x0: (w - mw) / 2, y0: (h - mh) / 2, mw, mh };
}

/** Screen position and depth. Depth is 1 at the globe's centre, 0 at its rim, negative behind; always 1 when flat. */
export function project(mode: MapMode, f: Frame, view: View, lon: number, lat: number): [number, number, number] {
  if (mode === 'flat') return [f.x0 + ((lon + 180) / 360) * f.mw, f.y0 + ((FLAT_NORTH - lat) / (FLAT_NORTH - FLAT_SOUTH)) * f.mh, 1];
  const l = (lon - view.lon) * RAD;
  const p = lat * RAD;
  const p0 = view.lat * RAD;
  const cosp = Math.cos(p);
  const x = cosp * Math.sin(l);
  const y = Math.cos(p0) * Math.sin(p) - Math.sin(p0) * cosp * Math.cos(l);
  const z = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * cosp * Math.cos(l);
  return [f.cx + f.r * x, f.cy - f.r * y, z];
}

/** The shortest turn from one longitude to another, in degrees (-180..180]. */
export const lonDelta = (from: number, to: number) => ((((to - from) % 360) + 540) % 360) - 180;
export const clampLat = (lat: number) => Math.max(-35, Math.min(50, lat));
