import type { CSSProperties, ReactNode } from 'react';
import { Box, Coins, Floor, Line, Part, Poly, Ring, Round, rounded, Scene, type P3, type Tone } from './iso';

/* ---------- small marks drawn on a top face, centred on (x, y) at height z */

function PostMark({ x, y, z, tone }: { x: number; y: number; z: number; tone: Tone }) {
  return (
    <g>
      <Poly fill={false} tone={tone} p={rounded(x - 0.55, y - 0.55, 1.1, 1.1, 0.28, z)} />
      <Ring tone={tone} x={x} y={y} z={z} r={0.26} />
      <Ring tone={tone} x={x + 0.33} y={y - 0.33} z={z} r={0.05} />
    </g>
  );
}
function MailMark({ x, y, z, tone }: { x: number; y: number; z: number; tone: Tone }) {
  return (
    <g>
      <Poly fill={false} tone={tone} p={[[x - 0.55, y - 0.4, z], [x + 0.55, y - 0.4, z], [x + 0.55, y + 0.4, z], [x - 0.55, y + 0.4, z]]} />
      <Line tone={tone} p={[[x - 0.55, y - 0.4, z], [x, y + 0.1, z], [x + 0.55, y - 0.4, z]]} />
    </g>
  );
}
function SearchMark({ x, y, z, tone }: { x: number; y: number; z: number; tone: Tone }) {
  return (
    <g>
      <Ring tone={tone} x={x - 0.1} y={y - 0.1} z={z} r={0.38} />
      <Line tone={tone} p={[[x + 0.17, y + 0.17, z], [x + 0.52, y + 0.52, z]]} />
    </g>
  );
}
function ChatMark({ x, y, z, tone }: { x: number; y: number; z: number; tone: Tone }) {
  return (
    <g>
      <Poly fill={false} tone={tone} p={[[x - 0.5, y - 0.4, z], [x + 0.5, y - 0.4, z], [x + 0.5, y + 0.3, z], [x - 0.05, y + 0.3, z], [x - 0.3, y + 0.56, z], [x - 0.3, y + 0.3, z], [x - 0.5, y + 0.3, z]]} />
      <Line tone={tone} p={[[x - 0.28, y - 0.15, z], [x + 0.28, y - 0.15, z]]} />
      <Line tone={tone} p={[[x - 0.28, y + 0.06, z], [x + 0.08, y + 0.06, z]]} />
    </g>
  );
}
const MARKS = [PostMark, MailMark, SearchMark, ChatMark];

/* ---------- from post to payment: one plate for every $100 a source brought in, and its route to the till */

const TOWERS = [
  { t: -5.1, plates: 12 },
  { t: -1.7, plates: 9 },
  { t: 1.7, plates: 5 },
  { t: 5.1, plates: 3 },
];
const PLATE = 0.3;
const STEP = 0.4;
const ROUTES: P3[][] = [
  [[-4.2, 5.1, 0], [3.3, 5.1, 0]],
  [[-1.7, 2.6, 0], [-1.7, 4.45, 0], [3.3, 4.45, 0]],
  [[2.6, -1.7, 0], [4.45, -1.7, 0], [4.45, 3.3, 0]],
  [[5.1, -4.2, 0], [5.1, 3.3, 0]],
];

export function RouteScene({ active, live, onLive, onPick }: { active: number; live: boolean; onLive: (live: boolean) => void; onPick: (i: number) => void }) {
  return (
    <Scene box={[-440, -286, 880, 552]} className="iso-route" onLive={onLive}>
      <Floor x={-6.6} y={-6.6} w={13.6} d={13.6} />
      {ROUTES.map((p, i) => i !== active && <Line key={i} tone="soft" dash p={p} />)}
      <Line key={`r${active}`} tone="hot" dash className="iso-flow" p={ROUTES[active]} />
      <Coins key={`c${active}`} p={ROUTES[active]} live={live} />
      {TOWERS.map(({ t, plates }, i) => {
        const on = i === active;
        const top = plates * STEP - (STEP - PLATE);
        const Mark = MARKS[i];
        return (
          <g key={t} className={`iso-tower${on ? ' is-on' : ''}`} onClick={() => onPick(i)}>
            {Array.from({ length: plates }, (_, k) => (
              <g key={k} className="iso-plate" style={{ '--k': k + i * 3 } as CSSProperties}>
                <Box x={t - 0.95} y={-t - 0.95} z={k * STEP} w={1.9} d={1.9} h={PLATE} tone={on ? 'hot' : 'line'} />
              </g>
            ))}
            <Part name="mark" i={plates + i * 3}>
              <Mark x={t} y={-t} z={top} tone={on ? 'hot' : 'line'} />
            </Part>
          </g>
        );
      })}
      {/* The till: a card reader that prints a receipt for each coin. */}
      <Part name="slip">
        <Poly tone="hot" p={[[3.6, 3.4, 0.4], [4.9, 3.4, 0.4], [4.9, 3.4, 2], [3.6, 3.4, 2]]} />
        <Line tone="hot" p={[[3.85, 3.4, 1.65], [4.65, 3.4, 1.65]]} />
        <Line tone="hot" p={[[3.85, 3.4, 1.35], [4.35, 3.4, 1.35]]} />
      </Part>
      <Box x={3.3} y={3.3} w={2.5} d={2.5} h={0.5}>
        <Poly p={[[3.6, 3.6, 0.5], [4.7, 3.6, 0.5], [4.7, 5.5, 0.5], [3.6, 5.5, 0.5]]} tone="hot" />
        {[0, 1, 2].map((r) => [0, 1].map((c) => <Ring key={`${r}${c}`} x={5.1 + c * 0.38} y={4 + r * 0.55} z={0.5} r={0.11} />))}
        <Line tone="hot" p={[[3.85, 4, 0.5], [4.45, 4, 0.5]]} />
        <Line tone="hot" p={[[3.85, 4.35, 0.5], [4.2, 4.35, 0.5]]} />
      </Box>
    </Scene>
  );
}

/* ---------- ask: one drawing for each question */

const ASK_BOX: [number, number, number, number] = [-250, -228, 500, 378];

const AskPodium = (
  <>
    <Floor x={-3.4} y={-3.4} w={6.8} d={6.8} />
    <Part name="rise">
      <Box x={-3} y={-1} w={2} d={2} h={1.8}>
        <MailMark x={-2} y={0} z={1.8} tone="line" />
      </Box>
    </Part>
    <Part name="rise" i={2}>
    <Box x={-1} y={-1} w={2} d={2} h={3} tone="hot">
      <PostMark x={0} y={0} z={3} tone="hot" />
    </Box>
    </Part>
    <Part name="rise" i={1}>
      <Box x={1} y={-1} w={2} d={2} h={0.9}>
        <SearchMark x={2} y={0} z={0.9} tone="line" />
      </Box>
    </Part>
  </>
);
const AskWeek = (
  <>
    <Floor x={-3.6} y={-3.4} w={7.2} d={6.8} />
    {[1.1, 1.5, 0.9, 1.3, 1.8, 2, 1.2].map((h, i) => (
      <Part key={i} name="rise" i={i * 0.5}>
        <Box x={-3 + i * 0.88} y={-1.5} w={0.6} d={0.9} h={h} tone="soft" />
      </Part>
    ))}
    {[1.3, 1.6, 1.2, 1.6, 2.1, 2.5, 1.5].map((h, i) => (
      <Part key={i} name="rise" i={4 + i * 0.5}>
        <Box x={-3 + i * 0.88} y={0.4} w={0.6} d={0.9} h={h * 0.62} tone="hot" />
      </Part>
    ))}
  </>
);
const QR = ['1110101', '1010011', '1110100', '0001011', '1101101', '0110010', '1011101'];
const AskFlyer = (
  <>
    <Floor x={-3.2} y={-3.2} w={6.4} d={6.4} />
    {/* a flyer standing up, and a phone looking at it */}
    <Box x={-2} y={-1.4} w={3} d={0.14} h={4} />
    <Line p={[[-1.6, -1.26, 3.6], [0.6, -1.26, 3.6]]} />
    <Line p={[[-1.6, -1.26, 3.25], [-0.2, -1.26, 3.25]]} />
    {QR.flatMap((row, r) =>
      [...row].map((c, i) => {
        const s = 0.27;
        const x = -1.45 + i * s;
        const z = 2.65 - r * s;
        return c === '1' ? <Poly key={`${r}-${i}`} tone="hot" p={[[x, -1.26, z], [x + s, -1.26, z], [x + s, -1.26, z - s], [x, -1.26, z - s]]} /> : null;
      }),
    )}
    <Part name="scan">
      <Line tone="hot" p={[[-1.65, -1.26, 2.75], [0.65, -1.26, 2.75]]} />
    </Part>
    <Line tone="hot" dash className="iso-flow" p={[[-0.5, -1.26, 1.7], [0.9, 1.3, 0.3]]} />
    <Round x={0.2} y={0.9} w={1.2} d={2.1} r={0.25} h={0.25}>
      <Poly fill={false} p={rounded(0.34, 1.06, 0.92, 1.6, 0.12, 0.25)} />
    </Round>
  </>
);
const AskLink = (
  <>
    <Floor x={-3.4} y={-3.2} w={6.8} d={6.4} />
    <Round x={-2.7} y={-2} w={5.4} d={4} r={0.35} h={0.3}>
      <Line p={[[-2.7, -1.15, 0.3], [2.7, -1.15, 0.3]]} />
      {[0, 1, 2].map((i) => <Ring key={i} x={-2.3 + i * 0.36} y={-1.58} z={0.3} r={0.11} />)}
      <Line tone="soft" p={[[-2.2, 1.2, 0.3], [0.6, 1.2, 0.3]]} />
      <Line tone="soft" p={[[-2.2, 1.55, 0.3], [-0.4, 1.55, 0.3]]} />
    </Round>
    <Part name="from-l">
    <Round x={-2} y={-0.55} z={1.5} w={2.6} d={1.1} r={0.5} h={0.28} tone="hot" />
    <Poly fill={false} tone="hot" p={rounded(-1.7, -0.28, 1.9, 0.56, 0.27, 1.78)} />
    </Part>
    <Part name="from-r">
    <Round x={-0.1} y={-0.55} z={1.9} w={2.6} d={1.1} r={0.5} h={0.28} tone="hot" />
    <Poly fill={false} tone="hot" p={rounded(0.3, -0.28, 1.9, 0.56, 0.27, 2.18)} />
    </Part>
    {[[-1.5, 0.3], [2, 0.3]].map(([x, y], i) => <Line key={i} tone="soft" dash p={[[x, y, 0.3], [x, y, 1.5]]} />)}
  </>
);
const AskLaunch = (
  <>
    <Floor x={-3.2} y={-3.2} w={6.4} d={6.4} />
    <Box x={-2.2} y={-2.2} w={4.4} d={4.4} h={0.45} />
    <Box x={-1.5} y={-1.5} z={0.45} w={3} d={3} h={0.45} />
    <Box x={-0.8} y={-0.8} z={0.9} w={1.6} d={1.6} h={0.45} />
    <Ring x={0} y={0} z={1.35} r={0.3} tone="hot" />
    <Line tone="hot" p={[[0, 0, 1.35], [0, 0, 4.9]]} />
    <Part name="hoist">
      <Part name="wave">
        <Poly tone="hot" p={[[0, 0, 4.9], [1.9, 0, 4.55], [1.35, 0, 4.05], [1.9, 0, 3.45], [0, 0, 3.75]]} />
      </Part>
    </Part>
  </>
);
const ASK_SCENES: ReactNode[] = [AskPodium, AskWeek, AskFlyer, AskLink, AskLaunch];

export function AskScene({ i }: { i: number }) {
  return (
    <Scene box={ASK_BOX} className="iso-ask">
      <g key={i}>{ASK_SCENES[i]}</g>
    </Scene>
  );
}

/* ---------- features */

/** A switch, off: AI assistants look only. */
export function SwitchScene() {
  return (
    <Scene box={[-315, -150, 620, 340]}>
      <Floor x={-4} y={-3} w={8} d={7.9} />
      <Round x={-3} y={-1.8} w={6} d={3.6} r={1.79} h={0.5}>
        <Poly fill={false} tone="soft" p={rounded(-2.65, -1.45, 5.3, 2.9, 1.44, 0.5)} />
      </Round>
      <g className="iso-knob">
        <Round x={-2.4} y={-1.2} z={0.5} w={2.4} d={2.4} r={1.19} h={0.8} tone="hot">
          <Ring tone="hot" x={-1.2} y={0} z={1.3} r={0.55} />
        </Round>
      </g>
      {/* three assistants, waiting outside */}
      {[0, 1, 2].map((k) => (
        <g key={k} className="iso-guest" style={{ '--k': k } as CSSProperties}>
          <Box x={-3 + k * 2.15} y={2.5} w={1.7} d={1.6} h={0.3}>
            <ChatMark x={-2.15 + k * 2.15} y={3.25} z={0.3} tone="line" />
          </Box>
        </g>
      ))}
    </Scene>
  );
}

/** Payments above, visits below; two are joined, one is not. */
export function MatchScene() {
  return (
    <Scene box={[-240, -200, 480, 330]}>
      <Floor x={-3.5} y={-3} w={7} d={6} />
      {[-2.2, 0, 2.2].map((x, i) => (
        <g key={x}>
          {i < 2 ? <Round x={x - 0.8} y={-0.8} w={1.6} d={1.6} r={0.79} h={0.22} /> : <Part name="seek"><Ring dash tone="soft" x={x} y={0} r={0.8} /></Part>}
        </g>
      ))}
      {[-2.2, 0].map((x) => (
        <g key={x}>
          <Line tone="hot" dash className="iso-flow" p={[[x, 0, 0.22], [x, 0, 2.5]]} />
        </g>
      ))}
      {[-2.2, 0, 2.2].map((x, i) => (
        <g key={x} className={i < 2 ? 'iso-bob' : 'iso-stray'} style={{ '--k': i } as CSSProperties}>
          <Box x={x - 0.85} y={-0.65} z={2.5} w={1.7} d={1.3} h={0.24} tone={i < 2 ? 'hot' : 'line'}>
            <Line tone={i < 2 ? 'hot' : 'line'} p={[[x - 0.85, -0.25, 2.74], [x + 0.85, -0.25, 2.74]]} />
            <Line tone={i < 2 ? 'hot' : 'line'} p={[[x - 0.55, 0.3, 2.74], [x - 0.05, 0.3, 2.74]]} />
          </Box>
        </g>
      ))}
    </Scene>
  );
}

/** A run of days with a flag on one of them. */
export function NotesScene() {
  const days = [0.7, 0.9, 0.8, 1.1, 1.3, 1.2, 1.9, 2.1, 2, 2.4, 2.3, 2.6];
  return (
    <Scene box={[-262, -196, 524, 312]}>
      <Floor x={-5.4} y={-2} w={10.8} d={4} />
      {days.map((h, i) => {
        const x = -4.9 + i * 0.82;
        return (
          <g key={i}>
            <Part name="rise" i={i * 0.7}>
              <Box x={x} y={-0.8} w={0.62} d={1.6} h={h * 0.75} tone={i >= 6 ? 'hot' : 'line'} />
            </Part>
            {i === 6 && (
              <g className="iso-flag">
                <Line p={[[x + 0.31, 0, h * 0.75], [x + 0.31, 0, h * 0.75 + 2.6]]} />
                <Poly p={[[x + 0.31, 0, h * 0.75 + 2.6], [x + 2.5, 0, h * 0.75 + 2.6], [x + 2.5, 0, h * 0.75 + 1.5], [x + 0.31, 0, h * 0.75 + 1.5]]} />
                <Line p={[[x + 0.65, 0, h * 0.75 + 2.25], [x + 2.1, 0, h * 0.75 + 2.25]]} />
                <Line p={[[x + 0.65, 0, h * 0.75 + 1.9], [x + 1.6, 0, h * 0.75 + 1.9]]} />
              </g>
            )}
          </g>
        );
      })}
    </Scene>
  );
}

const VISITS = [[3, 2], [1, 4], [4, 4], [2, 1]];

/** A street plan where a visitor shows up only as the square they are in. */
export function PlaceScene() {
  const N = 6;
  const S = 1.15;
  const o = (-N * S) / 2;
  return (
    <Scene box={[-300, -215, 600, 410]}>
      <Floor x={o - 0.5} y={o - 0.5} w={N * S + 1} d={N * S + 1} />
      {Array.from({ length: N * N }, (_, k) => {
        const i = k % N;
        const j = Math.floor(k / N);
        const turn = VISITS.findIndex(([a, b]) => a === i && b === j);
        const x = o + i * S + 0.1;
        const y = o + j * S + 0.1;
        return (
          <g key={k}>
            <Box x={x} y={y} w={S - 0.2} d={S - 0.2} h={0.14} tone={turn < 0 ? 'soft' : 'line'} />
            {turn >= 0 && (
              <Part name="visit" i={turn}>
                <Box x={x} y={y} w={S - 0.2} d={S - 0.2} h={0.85} tone="hot">
                  <Ring tone="hot" dash x={x + (S - 0.2) / 2} y={y + (S - 0.2) / 2} z={0.85} r={0.32} />
                </Box>
              </Part>
            )}
          </g>
        );
      })}
    </Scene>
  );
}

/** The plinth Spike stands on beside the questions. */
export function PlinthScene() {
  return (
    <Scene box={[-185, -60, 370, 190]}>
      <Floor x={-2.6} y={-2.6} w={5.2} d={5.2} />
      <Box x={-1.7} y={-1.7} w={3.4} d={3.4} h={0.35} />
      <Box x={-1.25} y={-1.25} z={0.35} w={2.5} d={2.5} h={0.35} />
    </Scene>
  );
}
