import { Button } from '../primitives/button';
import { useId } from 'react';
import { MapClusterPreview, type Preview } from '../MapClusterPreview';
import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { countryName } from '../../lib/format';
import { placeName } from '../../lib/realtime';
import { Flag, flagCode } from '../Icons';
import { clampLat, frameFor, landDots, lonDelta, project, type Frame, type MapMode, type View } from './geo';

/**
 * The live map without a mapping library: land as pre-sampled dots on a canvas (an orthographic globe or a flat
 * equirectangular world), places as real buttons laid over it. The canvas is decorative; every place is also in the
 * lists beside the map, which stay the accessible source of truth.
 *
 * Motion is opt-in from the parent (`animate`): the globe's slow drift, payment ripples and the flat map's travelling
 * dots only run while it is true, and the frame loop stops entirely otherwise. Selecting a place turns the globe to
 * it; with reduced motion the turn is a jump.
 *
 * Nearby places merge into one pin. Selecting a merged pin selects all of its places, and a small list next to it
 * lets the viewer narrow to one city (or go back to all).
 */

export interface MapPlace {
  key: string;
  lat: number;
  lon: number;
  country: string | null;
  city: string | null;
  count: number;
}

export interface Ripple {
  id: string;
  lat: number;
  lon: number;
  kind: 'payment' | 'refund';
  /** When it started (ms, Date.now()). */
  at: number;
}

export interface MapSelection {
  key: string | null;
  /** The places selected: one city, or every place in a merged pin. */
  keys: string[];
  /** Set when the selection came from a merged pin: all of its places, for the list beside it. */
  group?: string[];
  lat: number;
  lon: number;
  label: string;
}

interface Cluster {
  key: string;
  members: MapPlace[];
  total: number;
  country: string | null;
}

const RIPPLE_MS = 2400;
const DRIFT_DEG_PER_MS = 0.0024;
const TURN_MS = 650;
const IDLE_MS = 6000;

const rgb = (style: CSSStyleDeclaration, name: string, alpha = 1) => {
  const c = style.getPropertyValue(name).trim().split(/\s+/).join(',');
  return alpha < 1 ? `rgba(${c},${alpha})` : `rgb(${c})`;
};
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function LiveMap({
  mode,
  places,
  selected,
  onSelect,
  onClear,
  ripples = [],
  hub,
  animate,
  reduced,
  compact = false,
  themeKey,
  label,
  className = '',
}: {
  mode: MapMode;
  places: MapPlace[];
  selected?: MapSelection | null;
  /**
   * Without it the pins are pictures, not buttons (the Overview card is one big button). Called with the places to
   * select, and for a merged pin the whole group (largest place first).
   */
  onSelect?: (keys: string[], group?: string[]) => void;
  /** Escape in a merged pin's city list: let go of the selection. */
  onClear?: () => void;
  ripples?: Ripple[];
  /** Flat map only: draw arcs from each place to a pill with this label (the site). Symbolic, not network routes. */
  hub?: string;
  animate: boolean;
  reduced: boolean;
  compact?: boolean;
  /** Changes when the theme does, so the canvas redraws in the new colours. */
  themeKey?: string;
  label: string;
  /** Must position the map (e.g. `absolute inset-0`); it fills that box. */
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const previewSource = useMemo(() => ({ places, mode, themeKey }), [places, mode, themeKey]);
  const [storedPreview, setPreview] = useState<(Preview & { source: typeof previewSource }) | null>(null);
  const preview = storedPreview && storedPreview.source === previewSource && clusters.some(c => c.key === storedPreview.key) ? storedPreview : null;
  const previewId = useId();
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPreview = useRef(0);
  const cancelPreviewTimer = () => {
    if (previewTimer.current !== null) {
      clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
  };
  const closePreview = () => {
    cancelPreviewTimer();
    lastPreview.current = Date.now();
    setPreview(null);
  };
  const scheduleClose = () => {
    if (wrapRef.current?.contains(document.activeElement) && document.activeElement?.matches('.map-pin:focus-visible')) return;
    cancelPreviewTimer();
    previewTimer.current = setTimeout(() => {
      lastPreview.current = Date.now();
      setPreview(null);
    }, 100);
  };
  const showPreview = (c: Cluster, el: HTMLElement, immediate = false) => {
    if (mode !== 'flat' || !compact) return;
    cancelPreviewTimer();
    const host = wrapRef.current?.getBoundingClientRect();
    if (!host) return;
    const pin = el.getBoundingClientRect(),
      width = Math.min(240, window.innerWidth - 16),
      height = Math.min(window.innerHeight - 64, Math.min(4, c.members.length) * 32 + 52);
    const x = Math.max(8, Math.min(window.innerWidth - width - 8, pin.left + pin.width / 2 - width / 2));
    let y = pin.top - height - 8;
    if (y < 56) y = pin.bottom + 8;
    y = Math.max(56, Math.min(window.innerHeight - height - 8, y));
    const open = () => {
      lastPreview.current = Date.now();
      setPreview({
        source: previewSource,
        key: c.key,
        members: c.members,
        total: c.total,
        x,
        y,
        width,
        maxHeight: height,
      });
    };
    if (immediate || preview || Date.now() - lastPreview.current < 600) open();
    else previewTimer.current = setTimeout(open, 180);
  };
  useEffect(() => () => cancelPreviewTimer(), []);
  useEffect(() => {
    if (!preview) return;
    const close = (e: Event) => {
      if (e.target instanceof Element && e.target.closest('.v3-map-preview')) return;
      closePreview();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [preview?.key]);
  // Invalidate rendered previews synchronously through their source identity above.
  // Cleanup also prevents a delayed hover from reopening obsolete data.
  useLayoutEffect(() => () => cancelPreviewTimer(), [places, mode, themeKey]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const hubRef = useRef<HTMLDivElement>(null);
  const pinRefs = useRef(new Map<string, HTMLElement>());
  const size = useRef({ w: 0, h: 0 });
  const view = useRef<View>({
    lon: places[0]?.lon ?? 10,
    lat: clampLat(places[0]?.lat ?? 20),
  });
  const turn = useRef<{ from: View; to: View; start: number } | null>(null);
  const lastTouch = useRef(0);
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);
  const signature = useRef('');
  const props = useRef({
    mode,
    places,
    selected,
    ripples,
    hub,
    animate,
    compact,
  });
  props.current = { mode, places, selected, ripples, hub, animate, compact };

  const pinSize = compact ? 22 : 30;
  const stem = compact ? 4 : 7;
  const radius = compact ? 24 : 40;

  /** Draws one frame. Returns whether anything is still moving (so the loop knows whether to continue). */
  const draw = useCallback(
    (now: number): boolean => {
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return false;
      const { mode, places, selected, ripples, hub, animate, compact } = props.current;
      const { w, h } = size.current;
      if (!w || !h) return false;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return false;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const cs = getComputedStyle(wrap);
      const accent = (a = 1) => rgb(cs, '--c-accent', a);
      let moving = false;

      // The camera: a turn towards a selection, else a slow drift while nobody touches the globe.
      if (mode === 'globe') {
        const t = turn.current;
        if (t) {
          const k = Math.min(1, (now - t.start) / TURN_MS);
          const e = easeInOut(k);
          view.current = {
            lon: t.from.lon + lonDelta(t.from.lon, t.to.lon) * e,
            lat: t.from.lat + (t.to.lat - t.from.lat) * e,
          };
          if (k >= 1) turn.current = null;
          else moving = true;
        } else if (animate && !selected && !drag.current && now - lastTouch.current > IDLE_MS) {
          view.current = {
            lon: view.current.lon + DRIFT_DEG_PER_MS * 16.7,
            lat: view.current.lat,
          };
          moving = true;
        }
      }

      const f: Frame = frameFor(mode, w, h, compact ? 4 : mode === 'globe' ? 16 : 12);
      const v = view.current;

      // Sphere: a flat disc with a hairline edge.
      if (mode === 'globe') {
        ctx.beginPath();
        ctx.arc(f.cx, f.cy, f.r, 0, Math.PI * 2);
        ctx.fillStyle = rgb(cs, '--c-map-sphere');
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = rgb(cs, '--c-map-edge');
        ctx.stroke();
      }

      // Land.
      const dots = landDots(mode);
      ctx.fillStyle = rgb(cs, '--c-map-land');
      if (mode === 'globe') {
        for (let i = 0; i < dots.length; i += 2) {
          const [x, y, z] = project(mode, f, v, dots[i], dots[i + 1]);
          if (z <= 0) continue;
          ctx.globalAlpha = 0.25 + 0.65 * z;
          ctx.beginPath();
          ctx.arc(x, y, Math.max(0.5, (f.r / 200) * 1.25 * z), 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        const r = Math.max(0.55, (f.mw / 180) * 0.28);
        ctx.globalAlpha = 0.7;
        for (let i = 0; i < dots.length; i += 2) {
          const [x, y] = project(mode, f, v, dots[i], dots[i + 1]);
          ctx.fillRect(x - r, y - r, r * 2, r * 2);
        }
      }
      ctx.globalAlpha = 1;

      // The selected place: a crisp 2px ring in the accent at its exact spot, with a clear gap of ground around it so
      // the land dots don't crowd it. The pin above carries the same ring.
      if (selected) {
        const [x, y, z] = project(mode, f, v, selected.lon, selected.lat);
        if (z > 0.05) {
          const r = compact ? 4.5 : 7;
          ctx.fillStyle = rgb(cs, mode === 'globe' ? '--c-map-sphere' : '--c-map-stage');
          ctx.beginPath();
          ctx.arc(x, y, r + 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = accent();
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // Places on the visible side, merged when their pins would overlap. `places` comes largest first, so a cluster's
      // first member (and its key) is its largest place.
      const visible: { p: MapPlace; x: number; y: number }[] = [];
      for (const p of places) {
        const [x, y, z] = project(mode, f, v, p.lon, p.lat);
        if (z > 0.12) visible.push({ p, x, y });
      }
      const merged: { c: Cluster; x: number; y: number }[] = [];
      for (const it of visible) {
        const near = merged.find((m) => Math.hypot(m.x - it.x, m.y - it.y) < radius);
        if (near) {
          near.c.members.push(it.p);
          near.c.total += it.p.count;
          if (near.c.country !== it.p.country) near.c.country = null;
        } else
          merged.push({
            c: {
              key: it.p.key,
              members: [it.p],
              total: it.p.count,
              country: it.p.country,
            },
            x: it.x,
            y: it.y,
          });
      }

      // Flat map: symbolic arcs from each place to the site, with a dot travelling along while motion is on.
      const hubEl = hubRef.current;
      if (mode === 'flat' && hub && hubEl) {
        const hx = f.cx;
        const hy = f.y0 + f.mh * 0.93;
        hubEl.style.transform = `translate(${hx}px, ${hy}px) translate(-50%, -50%)`;
        ctx.lineWidth = 1;
        merged.slice(0, 12).forEach((m, i) => {
          const cx = m.x * 0.45 + hx * 0.55;
          const cy = Math.min(m.y, hy) - 60;
          ctx.strokeStyle = accent(0.35);
          ctx.beginPath();
          ctx.moveTo(m.x, m.y);
          ctx.quadraticCurveTo(cx, cy, hx, hy);
          ctx.stroke();
          if (animate) {
            const t = (((now / 2600 + i * 0.137) % 1) + 1) % 1;
            const u = 1 - t;
            ctx.fillStyle = accent(0.9);
            ctx.beginPath();
            ctx.arc(u * u * m.x + 2 * u * t * cx + t * t * hx, u * u * m.y + 2 * u * t * cy + t * t * hy, 2.25, 0, Math.PI * 2);
            ctx.fill();
            moving = true;
          }
        });
      }

      // Payment ripples from the buyer's city: rings in the revenue amber; refunds a dashed red ring that closes in.
      for (const r of ripples) {
        const [x, y, z] = project(mode, f, v, r.lon, r.lat);
        if (z <= 0.12) continue;
        const age = now - r.at;
        const refund = r.kind === 'refund';
        ctx.strokeStyle = rgb(cs, refund ? '--c-negative' : '--c-revenue', 1);
        ctx.setLineDash(refund ? [3, 3] : []);
        ctx.lineWidth = 1.5;
        if (animate && age < RIPPLE_MS * 1.5) {
          for (const phase of [0, 0.5]) {
            const k = (age / RIPPLE_MS - phase) % 1;
            if (k < 0 || age / RIPPLE_MS - phase > 1) continue;
            const rad = refund ? 34 - 26 * k : 8 + 30 * k;
            ctx.globalAlpha = (1 - k) * 0.8;
            ctx.beginPath();
            ctx.arc(x, y - (compact ? 0 : 4), rad, 0, Math.PI * 2);
            ctx.stroke();
          }
          moving = true;
        } else if (!animate) {
          // Still: one ring marks the place until the event ages out of the list.
          ctx.globalAlpha = 0.7;
          ctx.beginPath();
          ctx.arc(x, y - (compact ? 0 : 4), 18, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      ctx.setLineDash([]);

      // Pins: React renders the set when it changes; positions are written straight to the DOM every frame.
      const sig = JSON.stringify(merged.map(({ c }) => [c.key, c.total, c.country, c.members.map(p => [p.key, p.lat, p.lon, p.country, p.city, p.count])]));
      if (sig !== signature.current) {
        signature.current = sig;
        setClusters(merged.map((m) => m.c));
      }
      const lift = pinSize + stem;
      for (const m of merged) {
        const el = pinRefs.current.get(m.c.key);
        if (el) el.style.transform = `translate(${Math.round(m.x - 22)}px, ${Math.round(m.y - 44)}px)`;
      }

      // The selection's label (or, for a merged pin, its city list) above its pin; below it, or beside it, when the
      // map is too short. Always kept inside the map.
      const lab = labelRef.current;
      if (lab) {
        const sel = selected ? project(mode, f, v, selected.lon, selected.lat) : null;
        if (sel && sel[2] > 0.12) {
          const lw = lab.offsetWidth;
          const lh = lab.offsetHeight;
          let x = Math.max(8, Math.min(w - lw - 8, sel[0] - lw / 2));
          let y = sel[1] - lift - lh - 8;
          if (y < 8) {
            y = sel[1] + 12;
            if (y + lh > h - 8) {
              y = Math.max(8, Math.min(h - lh - 8, sel[1] - lift / 2 - lh / 2));
              x = sel[0] + 30 + lw <= w - 8 ? sel[0] + 30 : Math.max(8, sel[0] - 30 - lw);
            }
          }
          lab.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
          lab.style.visibility = 'visible';
        } else lab.style.visibility = 'hidden';
      }
      return moving;
    },
    [pinSize, stem, radius],
  );

  // Size.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => {
      size.current = { w: wrap.clientWidth, h: wrap.clientHeight };
      draw(Date.now());
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [draw]);

  // Turn to a new selection (a jump with reduced motion).
  const selKey = selected ? `${selected.key}|${selected.lat}|${selected.lon}` : '';
  useEffect(() => {
    if (!selected || mode !== 'globe') return;
    const to = { lon: selected.lon, lat: clampLat(selected.lat) };
    lastTouch.current = Date.now();
    if (reduced) {
      turn.current = null;
      view.current = to;
    } else turn.current = { from: { ...view.current }, to, start: Date.now() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, mode, reduced]);

  // The frame loop runs only while something moves; otherwise one frame per change.
  const [kick, setKick] = useState(0);
  useEffect(() => {
    let raf = 0;
    let stopped = false;
    const frame = () => {
      if (stopped) return;
      const moving = draw(Date.now());
      if (moving && (animate || turn.current)) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [draw, animate, mode, places, selected, ripples, hub, themeKey, kick, clusters]);

  // Drag to turn the globe; arrow keys turn it in steps (no animation for keyboard turns).
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (mode !== 'globe' || compact || (e.target as HTMLElement).closest('button, [data-map-card]')) return;
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    turn.current = null;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const r = Math.max(60, Math.min(size.current.w, size.current.h) / 2);
    const k = 57.3 / r;
    view.current = {
      lon: view.current.lon - (e.clientX - d.x) * k,
      lat: clampLat(view.current.lat + (e.clientY - d.y) * k),
    };
    drag.current = { ...d, x: e.clientX, y: e.clientY };
    lastTouch.current = Date.now();
    draw(Date.now());
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) {
      drag.current = null;
      lastTouch.current = Date.now();
      setKick((k) => k + 1);
    }
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && preview) {
      e.preventDefault();
      e.stopPropagation();
      closePreview();
      return;
    }
    if (mode !== 'globe' || e.target !== e.currentTarget) return;
    const step = {
      ArrowLeft: [-15, 0],
      ArrowRight: [15, 0],
      ArrowUp: [0, 10],
      ArrowDown: [0, -10],
    }[e.key];
    if (!step) return;
    e.preventDefault();
    turn.current = null;
    view.current = {
      lon: view.current.lon + step[0],
      lat: clampLat(view.current.lat + step[1]),
    };
    lastTouch.current = Date.now();
    draw(Date.now());
  };

  const interactive = !!onSelect;
  const turnable = interactive && mode === 'globe' && !compact;

  return (
    <div
      ref={wrapRef}
      className={`overflow-hidden ${turnable ? 'cursor-grab touch-none active:cursor-grabbing' : ''} ${className}`}
      role={turnable ? 'group' : undefined}
      aria-label={turnable ? label : undefined}
      aria-roledescription={turnable ? 'globe' : undefined}
      tabIndex={turnable ? 0 : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden="true" />
      {mode === 'flat' && hub && (
        <div ref={hubRef} className="pointer-events-none absolute left-0 top-0 whitespace-nowrap rounded-full bg-accentSoft px-3 py-1 text-xs font-medium text-accentInk" aria-hidden="true">
          {hub}
        </div>
      )}
      {preview && <MapClusterPreview id={previewId} preview={preview} onEnter={cancelPreviewTimer} onLeave={scheduleClose} />}
      {(() => {
        const keys = new Set(selected?.keys ?? []);
        const at = clusters.findIndex((c) => c.members.some((m) => keys.has(m.key)));
        // Escape in the city list hands focus back to the pin it belongs to.
        const pin = at >= 0 ? clusters[at].key : null;
        const clear = onClear
          ? () => {
              if (pin) pinRefs.current.get(pin)?.focus();
              onClear();
            }
          : undefined;
        const card = selected && !compact ? <SelectionCard key="selection" ref={labelRef} selection={selected} places={places} onSelect={onSelect} onClear={clear} /> : null;
        const pins = clusters.map((c) => {
          const ref = (el: HTMLElement | null) => {
            if (el) pinRefs.current.set(c.key, el);
            else pinRefs.current.delete(c.key);
          };
          const names = c.members.map((m) => placeName(m.city, m.country) ?? 'Unknown place');
          const name = `${names.length > 2 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(' and ')}: ${c.total} ${c.total === 1 ? 'visitor' : 'visitors'}`;
          const on = c.members.some((m) => keys.has(m.key));
          const content = <PinFace cluster={c} size={pinSize} stem={stem} />;
          const group = c.members.map((m) => m.key);
          return interactive ? (
            <Button variant="raw" size="raw"
              key={c.key}
              ref={ref}
              type="button"
              className="map-pin"
              aria-label={name}
              aria-pressed={on}
              data-map-cluster={c.key}
              aria-describedby={preview?.key === c.key ? previewId : undefined}
              title={mode === 'flat' && compact ? undefined : name}
              onPointerEnter={(e) => {
                if (e.pointerType === 'mouse' && matchMedia('(hover:hover) and (pointer:fine)').matches) showPreview(c, e.currentTarget);
              }}
              onPointerLeave={(e) => {
                if (!e.currentTarget.matches(':focus-visible')) scheduleClose();
              }}
              onFocus={(e) => {
                if (matchMedia('(hover:hover) and (pointer:fine)').matches || e.currentTarget.matches(':focus-visible')) showPreview(c, e.currentTarget, true);
              }}
              onBlur={scheduleClose}
              onClick={() => {
                closePreview();
                onSelect!(group, group.length > 1 ? group : undefined);
              }}
            >
              {content}
            </Button>
          ) : (
            <span key={c.key} ref={ref} className="map-pin pointer-events-none" aria-hidden="true">
              {content}
            </span>
          );
        });
        // The card follows its pin in the DOM, so Tab goes from a merged pin straight into its city list.
        if (card) pins.splice(at >= 0 ? at + 1 : pins.length, 0, card);
        return pins;
      })()}
    </div>
  );
}

const SelectionCard = forwardRef<
  HTMLDivElement,
  {
    selection: MapSelection;
    places: MapPlace[];
    onSelect?: (keys: string[], group?: string[]) => void;
    onClear?: () => void;
  }
>(function SelectionCard({ selection, places, onSelect, onClear }, ref) {
  const byKey = new Map(places.map((p) => [p.key, p]));
  const group = (selection.group ?? []).map((k) => byKey.get(k)).filter((p): p is MapPlace => !!p);
  // One place (or no way to choose): the plain label pill, a picture of the selection rather than a control.
  if (group.length < 2 || !onSelect) {
    return (
      <div
        ref={ref}
        className="pointer-events-none absolute left-0 top-0 z-10 max-w-[260px] truncate rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink"
        style={{ visibility: 'hidden' }}
        aria-hidden="true"
      >
        {selection.label}
      </div>
    );
  }
  const keys = group.map((p) => p.key);
  const chosen = new Set(selection.keys);
  const all = keys.every((k) => chosen.has(k));
  const total = group.reduce((a, p) => a + p.count, 0);
  const noun = group.every((p) => p.city) ? 'cities' : 'places';
  return (
    <div
      ref={ref}
      data-map-card
      role="group"
      aria-label="Places in this pin"
      className="absolute left-0 top-0 z-10 w-[224px] rounded-[14px] border border-line bg-surface p-1"
      style={{ visibility: 'hidden' }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !onClear) return;
        e.preventDefault();
        onClear();
      }}
    >
      <div className="truncate px-2.5 pb-1 pt-1.5 text-xs font-medium text-ink" aria-hidden="true">
        {selection.label}
      </div>
      <ul className="max-h-[172px] overflow-y-auto">
        <li>
          <Button variant="raw" size="raw" type="button" className="map-card-row" aria-pressed={all} onClick={() => !all && onSelect(keys, keys)}>
            <span className="min-w-0 flex-1 truncate">
              All {group.length} {noun}
            </span>
            <span className="tabular-nums text-muted">{total}</span>
          </Button>
        </li>
        {group.map((p) => {
          const on = !all && chosen.size === 1 && chosen.has(p.key);
          return (
            <li key={p.key}>
              <Button variant="raw" size="raw"
                type="button"
                className="map-card-row"
                aria-pressed={on}
                aria-label={`${placeName(p.city, p.country) ?? 'Unknown place'}: ${p.count} ${p.count === 1 ? 'visitor' : 'visitors'}`}
                onClick={() => onSelect(on ? keys : [p.key], keys)}
              >
                <Flag cc={p.country} size={16} />
                <span className="min-w-0 flex-1 truncate">{p.city ?? (p.country ? countryName(p.country) : 'Unknown place')}</span>
                <span className="tabular-nums text-muted">{p.count}</span>
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
});

function PinFace({ cluster, size, stem }: { cluster: Cluster; size: number; stem: number }) {
  const cc = flagCode(cluster.country);
  // A cluster of several countries shows its count, not one country's flag.
  return (
    <span className="relative flex flex-col items-center">
      <span className={`map-pin-disc ${cc ? 'bg-surface' : 'bg-ink text-onInk'}`} style={{ width: size, height: size }}>
        {cc ? <Flag cc={cc} size={size} edge={false} /> : <span className="tabular-nums">{cluster.total}</span>}
      </span>
      <span className="block w-0.5 rounded-full bg-accent" style={{ height: stem }} aria-hidden="true" />
      {cc && cluster.total > 1 && (
        <span className="map-pin-badge" style={{ top: -5, right: -7 }}>
          {cluster.total}
        </span>
      )}
    </span>
  );
}
