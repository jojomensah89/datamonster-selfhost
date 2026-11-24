/** A round step (1, 2 or 5 times a power of ten) of at least `rough`, and never below `minStep`. */
function roundStep(rough: number, minStep: number): number {
  const want = Math.max(rough, minStep);
  const power = 10 ** Math.floor(Math.log10(want) + 1e-9);
  const times = [1, 2, 5, 10].find((m) => m * power >= want * (1 - 1e-9)) ?? 10;
  return times * power;
}

/**
 * Evenly spaced, round ticks from 0 that cover every value. `minStep` is the smallest difference the labels can show,
 * so no two ticks read the same. With `intervals` the axis has exactly that many, to share another axis's gridlines.
 */
export function axisTicks(values: number[], minStep: number, intervals?: number): number[] {
  const finite = values.filter(Number.isFinite);
  const lo = Math.min(0, ...finite);
  const hi = Math.max(0, ...finite);
  if (lo === hi) return [0];
  const step = roundStep((hi - lo) / (intervals ?? 4), minStep);
  const first = Math.floor(lo / step + 1e-9);
  const last = intervals && lo === 0 ? intervals : Math.ceil(hi / step - 1e-9);
  return Array.from({ length: last - first + 1 }, (_, i) => Number(((first + i) * step).toPrecision(12)));
}

/** The range the ticks span. With nothing to plot, 0 sits on the baseline. */
export const axisDomain = (ticks: number[]): [number, number] => (ticks.length > 1 ? [ticks[0], ticks[ticks.length - 1]] : [0, 1]);
