import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import './spike-character.css';

/** Exact silhouette path shared with Spike.tsx so resting Spike is identical. */
export const SPIKE_BODY_D =
  'M 1018,265 Q 1024,255 1030,265 L 1052.5,312.5 ' +
  'C 1080,317 1100,329 1108.5,356 C 1118,382 1117,403 1097,415.5 ' +
  'H 978 C 961,415.5 956.5,402 956.5,381 C 956.5,359 964,342 977,325 Z';

export const SPIKE_EYE_LEFT_D =
  'M 990.5,354 Q 990.5,340 1004.5,340 Q 1018.5,340 1018.5,354 ' +
  'V 367.5 Q 1018.5,381.5 1004.5,381.5 Q 990.5,381.5 990.5,367.5 Z';

export const SPIKE_EYE_RIGHT_D =
  'M 1038.5,349 Q 1038.5,336.5 1054,336.5 Q 1070,336.5 1070,350 ' +
  'V 363 Q 1070,374.5 1055.5,374.5 Q 1038.5,374.5 1038.5,363 Z';

const SAD_EYE_LEFT_D =
  'M 990.5,362 Q 990.5,351 1004.5,346 Q 1018.5,341 1018.5,355 ' +
  'V 368.5 Q 1018.5,381.5 1004.5,381.5 Q 990.5,381.5 990.5,368.5 Z';

const SAD_EYE_RIGHT_D =
  'M 1038.5,349 Q 1038.5,338 1054,343 Q 1070,348 1070,358 ' +
  'V 364 Q 1070,374.5 1055.5,374.5 Q 1038.5,374.5 1038.5,364 Z';

const THINK_EYE_RIGHT_D =
  'M 1038.5,354 Q 1038.5,348 1054,348 Q 1070,348 1070,355 ' +
  'V 364 Q 1070,374.5 1055.5,374.5 Q 1038.5,374.5 1038.5,364 Z';

const WIDE_EYE_LEFT_D =
  'M 988.5,351 Q 988.5,336 1004.5,336 Q 1020.5,336 1020.5,351 ' +
  'V 370 Q 1020.5,384 1004.5,384 Q 988.5,384 988.5,370 Z';

const WIDE_EYE_RIGHT_D =
  'M 1036.5,346 Q 1036.5,332.5 1054,332.5 Q 1072,332.5 1072,347 ' +
  'V 365 Q 1072,377 1055.5,377 Q 1036.5,377 1036.5,365 Z';

export type SpikeMood =
  | 'idle'
  | 'look'
  | 'happy'
  | 'celebrate'
  | 'think'
  | 'sad'
  | 'sleep'
  | 'surprised'
  | 'greet'
  | 'hop';

export type SpikeReaction =
  | 'hop'
  | 'happy'
  | 'celebrate'
  | 'nod'
  | 'peek'
  | 'surprised'
  | 'greet'
  | 'think';

export interface SpikeTrigger {
  kind: SpikeReaction;
  key: number;
}

export interface SpikeCharacterProps {
  mood?: SpikeMood;
  size?: number;
  className?: string;
  trigger?: SpikeTrigger | null;
  /** Scales bounce height and tilt for bigger plans or big moments. */
  energy?: 1 | 2 | 3;
  /** Follow pointer with eyes on fine-pointer desktop devices while visible. */
  trackPointer?: boolean;
  /** Explicit gaze vector in [-1, 1] x [-1, 1]. */
  gaze?: { x: number; y: number } | null;
  /** Subtle hungry chomp accent when looking around with nothing to eat yet. */
  hungry?: boolean;
  /** Optional decorative click/tap handler (never focusable, always aria-hidden). */
  onPoke?: () => void;
  /** Convenience flag to hop when clicked or tapped. */
  allowClickHop?: boolean;
}

const REACTION_MS: Record<SpikeReaction, number> = {
  hop: 680,
  nod: 540,
  peek: 1580,
  happy: 960,
  celebrate: 1320,
  greet: 920,
  surprised: 740,
  think: 920,
};

const MAX_EYE_X = 9.5;
const MAX_EYE_Y = 7;

function hashSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

function clampGaze(x: number, y: number): [number, number] {
  const nx = x / MAX_EYE_X;
  const ny = y / MAX_EYE_Y;
  const len = Math.hypot(nx, ny);
  if (len <= 1) return [x, y];
  return [x / len, y / len];
}

function readReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function readFinePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

function moodForReaction(reaction: SpikeReaction | null, baseMood: SpikeMood): SpikeMood {
  if (!reaction) return baseMood;
  if (reaction === 'nod' || reaction === 'peek') return baseMood;
  return reaction;
}

/** Expressive animated Spike mascot. Always aria-hidden and non-focusable. */
export function SpikeCharacter({
  mood = 'idle',
  size = 120,
  className,
  trigger = null,
  energy = 2,
  trackPointer = false,
  gaze = null,
  hungry = false,
  onPoke,
  allowClickHop = false,
}: SpikeCharacterProps) {
  const maskId = useId();
  const seed = hashSeed(maskId);

  const svgRef = useRef<SVGSVGElement>(null);
  const gazeRef = useRef<SVGGElement>(null);
  const leanRef = useRef<SVGGElement>(null);

  const [reducedMotion, setReducedMotion] = useState(readReducedMotion);
  const [finePointer, setFinePointer] = useState(readFinePointer);
  const [onScreen, setOnScreen] = useState(true);
  const [tabVisible, setTabVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  const [blinking, setBlinking] = useState(false);
  const [activeReaction, setActiveReaction] = useState<{ kind: SpikeReaction; seq: number } | null>(null);
  const reactionSeq = useRef(0);
  const reactionTimer = useRef(0);

  const playReaction = (kind: SpikeReaction) => {
    if (reducedMotion) return;
    window.clearTimeout(reactionTimer.current);
    const seq = ++reactionSeq.current;
    setActiveReaction({ kind, seq });
    reactionTimer.current = window.setTimeout(() => {
      setActiveReaction((cur) => (cur?.seq === seq ? null : cur));
    }, REACTION_MS[kind]);
  };

  useEffect(() => () => window.clearTimeout(reactionTimer.current), []);

  // Sync reduced motion and pointer capability when motion is enabled.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const rmq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (rmq.matches) {
      setReducedMotion(true);
      return;
    }
    const onRm = () => setReducedMotion(rmq.matches);
    const pmq = window.matchMedia('(hover: hover) and (pointer: fine)');
    const onPm = () => setFinePointer(pmq.matches);
    setFinePointer(pmq.matches);
    rmq.addEventListener?.('change', onRm);
    pmq.addEventListener?.('change', onPm);
    return () => {
      rmq.removeEventListener?.('change', onRm);
      pmq.removeEventListener?.('change', onPm);
    };
  }, []);

  // Track visibility (IntersectionObserver + tab visibility) only when motion is allowed.
  useEffect(() => {
    if (reducedMotion) return;
    const onVis = () => setTabVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVis);

    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined' && svgRef.current) {
      io = new IntersectionObserver(
        ([entry]) => setOnScreen(entry ? entry.isIntersecting : true),
        { threshold: 0.01 },
      );
      io.observe(svgRef.current);
    }

    return () => {
      document.removeEventListener('visibilitychange', onVis);
      io?.disconnect();
    };
  }, [reducedMotion]);

  // Play external one-shot trigger whenever its key updates.
  const lastTriggerKey = useRef<number | null>(null);
  useEffect(() => {
    if (reducedMotion) {
      setActiveReaction(null);
      return;
    }
    if (!trigger || trigger.key === lastTriggerKey.current) return;
    lastTriggerKey.current = trigger.key;
    playReaction(trigger.kind);
  }, [trigger?.kind, trigger?.key, reducedMotion]);

  const effectiveMood = moodForReaction(activeReaction?.kind ?? null, mood);
  const paused = !onScreen || !tabVisible;
  const active = !reducedMotion && !paused;

  // Irregular organic blinking with occasional double-blink; off for closed/arc eyes.
  const canBlink =
    active &&
    effectiveMood !== 'sleep' &&
    effectiveMood !== 'happy' &&
    effectiveMood !== 'celebrate';

  useEffect(() => {
    if (!canBlink) {
      setBlinking(false);
      return;
    }
    let alive = true;
    let blinkTimer = 0;
    let endTimer = 0;
    let doubleTimer = 0;

    const doBlink = (allowDouble: boolean) => {
      if (!alive) return;
      setBlinking(true);
      endTimer = window.setTimeout(() => {
        if (!alive) return;
        setBlinking(false);
        if (allowDouble && Math.random() < 0.22) {
          doubleTimer = window.setTimeout(() => doBlink(false), 150);
        } else {
          schedule(2400 + Math.round(Math.random() * 3400));
        }
      }, 220);
    };

    const schedule = (delay: number) => {
      blinkTimer = window.setTimeout(() => doBlink(true), delay);
    };

    // Stagger initial blink by per-instance seed so multiple Spikes never blink together.
    schedule(900 + Math.round(seed * 2600) + Math.round(Math.random() * 1100));

    return () => {
      alive = false;
      window.clearTimeout(blinkTimer);
      window.clearTimeout(endTimer);
      window.clearTimeout(doubleTimer);
    };
  }, [canBlink, seed]);

  // Gaze state: pointer following (on-demand rAF only while moving), explicit gaze, or mood look-around.
  const gazeState = useRef({ curX: 0, curY: 0, targetX: 0, targetY: 0, curTilt: 0, targetTilt: 0, raf: 0 });
  const pointerActiveRef = useRef(false);

  useEffect(() => {
    const g = gazeRef.current;
    const l = leanRef.current;
    const st = gazeState.current;

    const applyNow = (x: number, y: number, tilt: number) => {
      st.curX = x;
      st.curY = y;
      st.curTilt = tilt;
      if (g) g.setAttribute('transform', x || y ? `translate(${x.toFixed(2)} ${y.toFixed(2)})` : '');
      if (l) l.style.transform = Math.abs(tilt) > 0.05 ? `rotate(${tilt.toFixed(2)}deg)` : '';
    };

    if (reducedMotion) {
      if (gaze) {
        const [cx, cy] = clampGaze(gaze.x * MAX_EYE_X, gaze.y * MAX_EYE_Y);
        applyNow(cx, cy, 0);
      } else if (effectiveMood === 'think') {
        applyNow(5.5, -4.5, 0);
      } else if (effectiveMood === 'sad') {
        applyNow(-3, 4, 0);
      } else {
        applyNow(0, 0, 0);
      }
      return;
    }

    if (paused) {
      if (st.raf) {
        cancelAnimationFrame(st.raf);
        st.raf = 0;
      }
      return;
    }

    const step = () => {
      st.curX += (st.targetX - st.curX) * 0.2;
      st.curY += (st.targetY - st.curY) * 0.2;
      st.curTilt += (st.targetTilt - st.curTilt) * 0.14;
      if (g) g.setAttribute('transform', `translate(${st.curX.toFixed(2)} ${st.curY.toFixed(2)})`);
      if (l) l.style.transform = Math.abs(st.curTilt) > 0.05 ? `rotate(${st.curTilt.toFixed(2)}deg)` : '';

      const done =
        Math.abs(st.targetX - st.curX) < 0.05 &&
        Math.abs(st.targetY - st.curY) < 0.05 &&
        Math.abs(st.targetTilt - st.curTilt) < 0.05;

      if (done) {
        applyNow(st.targetX, st.targetY, st.targetTilt);
        st.raf = 0;
      } else {
        st.raf = requestAnimationFrame(step);
      }
    };

    const driveTo = (x: number, y: number, tilt = 0) => {
      const [cx, cy] = clampGaze(x, y);
      st.targetX = cx;
      st.targetY = cy;
      st.targetTilt = Math.max(-3.5, Math.min(3.5, tilt));
      if (!st.raf) st.raf = requestAnimationFrame(step);
    };

    // Mood-specific baseline gaze targets when not overridden by pointer or explicit gaze.
    if (effectiveMood === 'sleep') {
      driveTo(0, 2.5, 0);
      return () => {
        if (st.raf) {
          cancelAnimationFrame(st.raf);
          st.raf = 0;
        }
      };
    }

    if (gaze) {
      driveTo(gaze.x * MAX_EYE_X, gaze.y * MAX_EYE_Y, gaze.x * 2.4);
    } else if (effectiveMood === 'think') {
      driveTo(6, -5, 1.5);
    } else if (effectiveMood === 'happy' || effectiveMood === 'celebrate' || effectiveMood === 'surprised') {
      driveTo(0, -1, 0);
    } else if (effectiveMood !== 'look' && effectiveMood !== 'sad') {
      driveTo(0, 0, 0);
    }

    let glanceTimer = 0;
    let glanceStep = 0;

    const scheduleGlance = () => {
      if (gaze) return;
      if (pointerActiveRef.current) {
        glanceTimer = window.setTimeout(scheduleGlance, 1200);
        return;
      }
      if (effectiveMood === 'look') {
        const stops: [number, number][] = [
          [-7.5, -1],
          [7.5, -2],
          [4.5, 4],
          [-6, 3],
          [0, -4.5],
        ];
        const [gx, gy] = stops[glanceStep % stops.length];
        glanceStep++;
        driveTo(gx, gy, gx * 0.28);
        glanceTimer = window.setTimeout(scheduleGlance, 1300 + Math.round(Math.random() * 900));
      } else if (effectiveMood === 'sad') {
        const stops: [number, number][] = [
          [-6.5, 4],
          [5.5, 4.5],
          [-2, 5.5],
        ];
        const [gx, gy] = stops[glanceStep % stops.length];
        glanceStep++;
        driveTo(gx, gy, gx * 0.18);
        glanceTimer = window.setTimeout(scheduleGlance, 2200 + Math.round(Math.random() * 1200));
      } else if (effectiveMood === 'think') {
        const stops: [number, number][] = [
          [6.5, -5],
          [-4.5, -5.5],
          [5, -3.5],
        ];
        const [gx, gy] = stops[glanceStep % stops.length];
        glanceStep++;
        driveTo(gx, gy, gx * 0.22);
        glanceTimer = window.setTimeout(scheduleGlance, 1500 + Math.round(Math.random() * 800));
      } else if (effectiveMood === 'idle') {
        const roll = Math.random();
        if (roll < 0.45) {
          driveTo(0, 0, 0);
        } else {
          const gx = (Math.random() * 2 - 1) * 5.5;
          const gy = (Math.random() * 2 - 1) * 3.5;
          driveTo(gx, gy, gx * 0.2);
        }
        glanceTimer = window.setTimeout(scheduleGlance, 2800 + Math.round(Math.random() * 2600));
      }
    };

    if (!gaze && (effectiveMood === 'look' || effectiveMood === 'sad' || effectiveMood === 'think' || effectiveMood === 'idle')) {
      glanceTimer = window.setTimeout(
        scheduleGlance,
        effectiveMood === 'idle' ? 2400 + Math.round(seed * 2400) : 450,
      );
    }

    // Pointer tracking on desktop only, while on screen and tab visible.
    const enablePointer = trackPointer && finePointer && !gaze;
    let pointerIdleTimer = 0;

    const onPointerMove = (e: PointerEvent) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const cx = rect.left + rect.width * 0.5;
      const cy = rect.top + rect.height * 0.56;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const dist = Math.hypot(dx, dy);
      const strength = Math.tanh(dist / 220);
      const ux = dist > 0.001 ? dx / dist : 0;
      const uy = dist > 0.001 ? dy / dist : 0;
      const tx = ux * MAX_EYE_X * strength;
      const ty = uy * MAX_EYE_Y * strength;
      pointerActiveRef.current = true;
      window.clearTimeout(pointerIdleTimer);
      pointerIdleTimer = window.setTimeout(() => {
        pointerActiveRef.current = false;
      }, 2400);
      driveTo(tx, ty, tx * 0.3);
    };

    const onPointerLeave = () => {
      pointerActiveRef.current = false;
      driveTo(0, 0, 0);
    };

    if (enablePointer) {
      window.addEventListener('pointermove', onPointerMove, { passive: true });
      document.documentElement.addEventListener('pointerleave', onPointerLeave, { passive: true });
    }

    return () => {
      window.clearTimeout(glanceTimer);
      window.clearTimeout(pointerIdleTimer);
      pointerActiveRef.current = false;
      if (enablePointer) {
        window.removeEventListener('pointermove', onPointerMove);
        document.documentElement.removeEventListener('pointerleave', onPointerLeave);
      }
      if (st.raf) {
        cancelAnimationFrame(st.raf);
        st.raf = 0;
      }
    };
  }, [effectiveMood, gaze?.x, gaze?.y, paused, reducedMotion, trackPointer, finePointer, seed]);

  const interactive = Boolean(onPoke || allowClickHop);
  const handleHit = () => {
    if (!interactive) return;
    if (allowClickHop && !reducedMotion) {
      playReaction('hop');
    }
    onPoke?.();
  };

  const renderEyes = () => {
    if (effectiveMood === 'happy' || effectiveMood === 'celebrate') {
      return (
        <>
          <path
            className="spike-char__eye spike-char__eye--left"
            d="M 991,367 Q 1004.5,345 1018,367"
            fill="none"
            stroke="black"
            strokeWidth="10.5"
            strokeLinecap="round"
          />
          <path
            className="spike-char__eye spike-char__eye--right"
            d="M 1039,362 Q 1054.2,341 1069.5,362"
            fill="none"
            stroke="black"
            strokeWidth="10.5"
            strokeLinecap="round"
          />
        </>
      );
    }

    if (effectiveMood === 'sleep') {
      return (
        <>
          <path
            className="spike-char__eye spike-char__eye--left"
            d="M 991.5,360 Q 1004.5,373 1017.5,360"
            fill="none"
            stroke="black"
            strokeWidth="8.5"
            strokeLinecap="round"
          />
          <path
            className="spike-char__eye spike-char__eye--right"
            d="M 1039.5,355 Q 1054.2,368 1069,355"
            fill="none"
            stroke="black"
            strokeWidth="8.5"
            strokeLinecap="round"
          />
        </>
      );
    }

    if (effectiveMood === 'sad') {
      return (
        <>
          <path className="spike-char__eye spike-char__eye--left" d={SAD_EYE_LEFT_D} fill="black" />
          <path className="spike-char__eye spike-char__eye--right" d={SAD_EYE_RIGHT_D} fill="black" />
        </>
      );
    }

    if (effectiveMood === 'think') {
      return (
        <>
          <path className="spike-char__eye spike-char__eye--left" d={SPIKE_EYE_LEFT_D} fill="black" />
          <path className="spike-char__eye spike-char__eye--right" d={THINK_EYE_RIGHT_D} fill="black" />
        </>
      );
    }

    if (effectiveMood === 'surprised') {
      return (
        <>
          <path className="spike-char__eye spike-char__eye--left" d={WIDE_EYE_LEFT_D} fill="black" />
          <path className="spike-char__eye spike-char__eye--right" d={WIDE_EYE_RIGHT_D} fill="black" />
        </>
      );
    }

    return (
      <>
        <path className="spike-char__eye spike-char__eye--left" d={SPIKE_EYE_LEFT_D} fill="black" />
        <path className="spike-char__eye spike-char__eye--right" d={SPIKE_EYE_RIGHT_D} fill="black" />
      </>
    );
  };

  const renderMouth = () => {
    if (effectiveMood === 'happy') {
      return (
        <path
          className="spike-char__mouth"
          d="M 1019,388 Q 1031,398 1043,386"
          fill="none"
          stroke="black"
          strokeWidth="6.5"
          strokeLinecap="round"
        />
      );
    }
    if (effectiveMood === 'celebrate') {
      return (
        <path
          className="spike-char__mouth"
          d="M 1014,383 Q 1031,389 1048,381 Q 1046,403 1031,404 Q 1016,403 1014,383 Z"
          fill="black"
        />
      );
    }
    if (effectiveMood === 'sad') {
      return (
        <path
          className="spike-char__mouth"
          d="M 1020,398 Q 1031,389 1042,396"
          fill="none"
          stroke="black"
          strokeWidth="5.5"
          strokeLinecap="round"
        />
      );
    }
    if (effectiveMood === 'surprised') {
      return <ellipse className="spike-char__mouth" cx="1031" cy="393" rx="7.5" ry="9" fill="black" />;
    }
    if (effectiveMood === 'look' && hungry) {
      return <ellipse className="spike-char__mouth spike-char__mouth--chomp" cx="1031" cy="393" rx="10" ry="7" fill="black" />;
    }
    return null;
  };

  const renderProps = () => {
    if (effectiveMood === 'celebrate') {
      return (
        <g className="spike-char__prop" fill="currentColor">
          {/* Tiny flat celebratory arms */}
          <path
            className="spike-char__arm spike-char__arm--left"
            d="M 964,366 Q 941,353 945,335 Q 949,322 961,329 Q 968,334 971,349 Z"
          />
          <path
            className="spike-char__arm spike-char__arm--right"
            d="M 1106,360 Q 1129,346 1125,328 Q 1121,316 1109,323 Q 1102,329 1099,344 Z"
          />
          {/* Flat geometric sparkles and coin */}
          <path
            className="spike-char__spark"
            d="M 966,262 L 969.5,272.5 L 980,276 L 969.5,279.5 L 966,290 L 962.5,279.5 L 952,276 L 962.5,272.5 Z"
          />
          <g className="spike-char__spark spike-char__spark--2">
            <circle cx="1074" cy="258" r="11" fill="none" stroke="currentColor" strokeWidth="4" />
            <rect x="1072.2" y="252" width="3.6" height="12" rx="1.8" />
          </g>
          <path
            className="spike-char__spark spike-char__spark--3"
            d="M 1104,274 L 1106.8,282.2 L 1115,285 L 1106.8,287.8 L 1104,296 L 1101.2,287.8 L 1093,285 L 1101.2,282.2 Z"
          />
        </g>
      );
    }

    if (effectiveMood === 'think') {
      return (
        <g className="spike-char__prop" fill="currentColor">
          <rect className="spike-char__bar spike-char__bar--1" x="1084" y="293" width="8" height="15" rx="3" />
          <rect className="spike-char__bar spike-char__bar--2" x="1096" y="282" width="8" height="26" rx="3" />
          <rect className="spike-char__bar spike-char__bar--3" x="1108" y="269" width="8" height="39" rx="3" />
        </g>
      );
    }

    if (effectiveMood === 'sleep') {
      return (
        <g className="spike-char__prop" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          <path className="spike-char__z spike-char__z--1" d="M 1068,292 H 1079 L 1068,303 H 1079" strokeWidth="4" />
          <path className="spike-char__z spike-char__z--2" d="M 1084,269 H 1099 L 1084,284 H 1099" strokeWidth="4.6" />
          <path className="spike-char__z spike-char__z--3" d="M 1103,246 H 1122 L 1103,265 H 1122" strokeWidth="5.2" />
        </g>
      );
    }

    if (effectiveMood === 'surprised') {
      return (
        <g className="spike-char__prop" stroke="currentColor" strokeWidth="5" strokeLinecap="round">
          <line className="spike-char__tick" x1="1006" y1="252" x2="998" y2="239" />
          <line className="spike-char__tick" x1="1024" y1="246" x2="1024" y2="233" />
          <line className="spike-char__tick" x1="1042" y1="252" x2="1050" y2="239" />
        </g>
      );
    }

    if (effectiveMood === 'greet') {
      return (
        <g className="spike-char__prop" fill="none" stroke="currentColor" strokeLinecap="round">
          <path className="spike-char__wave-arc spike-char__wave-arc--1" d="M 976,284 Q 981,271 994,267" strokeWidth="5" />
          <path className="spike-char__wave-arc spike-char__wave-arc--2" d="M 964,279 Q 970,262 988,256" strokeWidth="4.5" />
        </g>
      );
    }

    if (effectiveMood === 'hop') {
      return (
        <g className="spike-char__prop" fill="currentColor">
          <ellipse className="spike-char__foot spike-char__foot--left" cx="1002" cy="418" rx="13" ry="8" />
          <ellipse className="spike-char__foot spike-char__foot--right" cx="1064" cy="418" rx="13" ry="8" />
        </g>
      );
    }

    return null;
  };

  const classes = [
    'spike-char',
    'spike-icon',
    interactive ? 'spike-char--interactive' : 'spike-char--passive',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const phaseStyle = { '--spike-phase': `${(-seed * 3.2).toFixed(2)}s` } as CSSProperties;

  return (
    <svg
      ref={svgRef}
      aria-hidden="true"
      focusable="false"
      className={classes}
      style={phaseStyle}
      width={size}
      height={size}
      viewBox="923.2 231.2 217.6 217.6"
      data-mood={effectiveMood}
      data-energy={energy}
      data-reaction={activeReaction?.kind}
      data-pulse={activeReaction ? String(activeReaction.seq % 2) : undefined}
      data-hungry={hungry ? 'true' : undefined}
      data-blinking={blinking ? 'true' : undefined}
      data-paused={paused ? 'true' : undefined}
      data-reduced-motion={reducedMotion ? 'true' : undefined}
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="900" y="210" width="264" height="264">
          <rect x="900" y="210" width="264" height="264" fill="white" />
          <g ref={gazeRef} className="spike-char__gaze">
            <g className="spike-char__eyes">{renderEyes()}</g>
            {renderMouth()}
          </g>
        </mask>
      </defs>
      <g ref={leanRef} className="spike-char__lean">
        <g className="spike-char__rig">
          <path
            className="spike-char__hit"
            fill="currentColor"
            mask={`url(#${maskId})`}
            d={SPIKE_BODY_D}
            onClick={interactive ? handleHit : undefined}
          />
          {renderProps()}
        </g>
      </g>
    </svg>
  );
}
