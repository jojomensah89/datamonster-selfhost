import { useEffect, type RefObject } from 'react';
import { FLAT_LAND } from '../assets/land-dots';

const WORD = 'DATAMONSTER';
const DENSE = '#$%*+=:.';

function hash(x: number, y: number, s: number) {
  let h = (x * 374761393 + y * 668265263 + s * 982451653) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Smooth value noise for the drifting terrain. */
function vnoise(x: number, y: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const s = (t: number) => t * t * (3 - 2 * t);
  const h = (a: number, b: number) => hash(a, b, 11);
  const top = h(xi, yi) + (h(xi + 1, yi) - h(xi, yi)) * s(xf);
  const bot = h(xi, yi + 1) + (h(xi + 1, yi + 1) - h(xi, yi + 1)) * s(xf);
  return top + (bot - top) * s(yf);
}

/** The flat land mask on its 2° grid: rows from north to south, 180 cells of longitude each. */
interface LandMask {
  rows: number;
  cols: number;
  latTop: number;
  bits: Uint8Array;
}
let mask: LandMask | null = null;
function landMask(): LandMask {
  if (mask) return mask;
  const rows = FLAT_LAND.split('|').map((r) => r.split(':'));
  const lats = rows.map(([lat]) => Number(lat));
  const latTop = Math.max(...lats);
  const n = Math.round((latTop - Math.min(...lats)) / 2) + 1;
  const cols = Number(rows[0][1]);
  const bits = new Uint8Array(n * cols);
  for (const [lat, , runs] of rows) {
    const y = Math.round((latTop - Number(lat)) / 2);
    const r = runs.split(',').map(Number);
    for (let i = 0; i < r.length; i += 2) bits.fill(1, y * cols + r[i], y * cols + r[i] + r[i + 1]);
  }
  return (mask = { rows: n, cols, latTop, bits });
}

/**
 * The hero's glyph field: a world map drawn in characters over drifting terrain.
 * The map fills the box of `mapRef` (placed by CSS, so each breakpoint decides where the map sits).
 * The cursor "eats" glyphs, which scramble into the name and vanish at its centre.
 * With reduced motion it draws one still frame and ignores the pointer.
 */
export function useGlyphField(
  stageRef: RefObject<HTMLElement>,
  canvasRef: RefObject<HTMLCanvasElement>,
  mapRef?: RefObject<HTMLElement>,
) {
  useEffect(() => {
    const stage = stageRef.current;
    const cv = canvasRef.current;
    const ctx = cv?.getContext('2d');
    if (!stage || !cv || !ctx) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let W = 0;
    let H = 0;
    let cell = 15;
    let cols = 0;
    let rows = 0;
    let grid: Uint8Array = new Uint8Array(0);
    let eaten: Float32Array = new Float32Array(0);
    const mouse = { x: -999, y: -999 };
    const target = { x: -999, y: -999 };
    const t0 = performance.now();
    let raf = 0;
    let visible = true;

    // The land mask stretched over the map box, in cell units.
    const box = { x: 0, y: 0, w: 0, h: 0 };
    function shape(cx: number, cy: number) {
      if (box.w <= 0 || box.h <= 0) return 0;
      const u = (cx - box.x) / box.w;
      const v = (cy - box.y) / box.h;
      if (u < 0 || u >= 1 || v < 0 || v >= 1) return 0;
      const m = landMask();
      return m.bits[Math.floor(v * m.rows) * m.cols + Math.floor(u * m.cols)];
    }

    function resize() {
      const r = cv!.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = r.width;
      H = r.height;
      cv!.width = Math.max(1, Math.round(W * dpr));
      cv!.height = Math.max(1, Math.round(H * dpr));
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      cell = W < 700 ? 12 : 14;
      cols = Math.ceil(W / (cell * 0.62));
      rows = Math.ceil(H / cell);
      const cw = cell * 0.62;
      const mr = mapRef?.current?.getBoundingClientRect();
      if (mr && mr.width > 0) {
        box.x = (mr.left - r.left) / cw;
        box.y = (mr.top - r.top) / cell;
        box.w = mr.width / cw;
        box.h = mr.height / cell;
      } else box.w = box.h = 0;
      grid = new Uint8Array(cols * rows);
      eaten = new Float32Array(cols * rows);
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) grid[y * cols + x] = shape(x, y);
      ctx!.font = `500 ${cell - 3}px ui-monospace, Menlo, Consolas, monospace`; // taste-skill-ignore: the glyph field is a drawn picture
      ctx!.textBaseline = 'top';
    }

    function draw(now: number) {
      const t = reduce ? 0 : (now - t0) / 1000;
      ctx!.clearRect(0, 0, W, H);
      const cw = cell * 0.62;
      const R = Math.max(80, W * 0.09);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const i = y * cols + x;
          const px = x * cw;
          const py = y * cell;
          const d = Math.hypot(px + cw / 2 - mouse.x, py + cell / 2 - mouse.y);
          if (d < R) eaten[i] = Math.min(1, eaten[i] + 0.3 * (1 - d / R));
          else eaten[i] *= 0.97;
          const e = eaten[i];
          const n = vnoise(x * 0.055 + t * 0.12, y * 0.09 - t * 0.05) * 0.7 + vnoise(x * 0.16, y * 0.22 + t * 0.2) * 0.3;
          let ch: string;
          let alpha: number;
          if (e > 0.12) {
            // The monster chews: glyphs scramble into its name and are gone at the centre.
            if (e > 0.72) continue;
            ch = WORD[(x * 3 + y + Math.floor(t * 10)) % WORD.length];
            alpha = 0.95;
          } else if (grid[i]) {
            ch = DENSE[Math.floor(hash(x, y, Math.floor(t * 3)) * 3)];
            alpha = 1;
          } else if (n > 0.6) {
            ch = DENSE[Math.min(DENSE.length - 1, Math.floor((1 - (n - 0.6) / 0.4) * 6) + Math.floor(hash(x, y, Math.floor(t * 2)) * 2))];
            alpha = 0.55;
          } else if (n > 0.55) {
            ch = '.';
            alpha = 0.35;
          } else continue;
          ctx!.fillStyle = `rgba(255,255,255,${alpha})`;
          ctx!.fillText(ch, px, py);
        }
      }
    }

    function frame(now: number) {
      if (target.x > -500) {
        mouse.x += (target.x - mouse.x) * 0.18;
        mouse.y += (target.y - mouse.y) * 0.18;
      }
      draw(now);
      raf = visible ? requestAnimationFrame(frame) : 0;
    }

    function start() {
      if (reduce) {
        draw(0);
        return;
      }
      if (!raf) raf = requestAnimationFrame(frame);
    }

    resize();
    start();

    const ro = new ResizeObserver(() => {
      resize();
      if (reduce) draw(0);
    });
    ro.observe(cv);
    if (mapRef?.current) ro.observe(mapRef.current);

    // Only animate while the stage is on screen.
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) start();
    });
    io.observe(stage);

    const onMove = (e: PointerEvent) => {
      if (reduce) return;
      const r = cv.getBoundingClientRect();
      target.x = e.clientX - r.left;
      target.y = e.clientY - r.top;
      if (mouse.x < -500) {
        mouse.x = target.x;
        mouse.y = target.y;
      }
    };
    const onLeave = () => {
      target.x = target.y = mouse.x = mouse.y = -999;
    };
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerleave', onLeave);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerleave', onLeave);
    };
  }, [stageRef, canvasRef, mapRef]);
}
