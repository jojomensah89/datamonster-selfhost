// @vitest-environment jsdom
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import {
  SPIKE_BODY_D,
  SPIKE_EYE_LEFT_D,
  SPIKE_EYE_RIGHT_D,
  SpikeCharacter,
  type SpikeMood,
} from '../src/dashboard/components/SpikeCharacter';

const ALL_MOODS: SpikeMood[] = [
  'idle',
  'look',
  'happy',
  'celebrate',
  'think',
  'sad',
  'sleep',
  'surprised',
  'greet',
  'hop',
];

function mockMatchMedia(reducedMotion: boolean, finePointer = true) {
  const listeners = new Map<string, Set<EventListener>>();
  const stub = vi.fn((query: string) => {
    const isReduced = query.includes('prefers-reduced-motion');
    const isFine = query.includes('pointer: fine');
    const set = listeners.get(query) ?? new Set<EventListener>();
    listeners.set(query, set);
    return {
      matches: isReduced ? reducedMotion : isFine ? finePointer : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn((_ev: string, fn: EventListener) => set.add(fn)),
      removeEventListener: vi.fn((_ev: string, fn: EventListener) => set.delete(fn)),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList;
  });
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: stub });
  return stub;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('SpikeCharacter', () => {
  it('renders every mood, stays aria-hidden and non-focusable, and matches the resting silhouette', () => {
    mockMatchMedia(false);
    for (const mood of ALL_MOODS) {
      const { container, unmount } = render(h(SpikeCharacter, { mood, size: 120 }));
      const svg = container.querySelector('svg')!;
      expect(svg).toBeTruthy();
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('focusable')).toBe('false');
      expect(svg.getAttribute('tabindex')).toBeNull();
      expect(svg.getAttribute('data-mood')).toBe(mood);
      expect(svg.getAttribute('viewBox')).toBe('923.2 231.2 217.6 217.6');
      const body = svg.querySelector('path.spike-char__hit')!;
      expect(body.getAttribute('d')).toBe(SPIKE_BODY_D);
      if (mood === 'idle') {
        const eyes = svg.querySelectorAll('.spike-char__eye');
        expect(eyes.length).toBe(2);
        expect(eyes[0].getAttribute('d')).toBe(SPIKE_EYE_LEFT_D);
        expect(eyes[1].getAttribute('d')).toBe(SPIKE_EYE_RIGHT_D);
      }
      unmount();
    }
  });

  it('assigns unique mask ids when multiple Spikes render on the same page', () => {
    mockMatchMedia(false);
    const { container } = render(
      h('div', null,
        h(SpikeCharacter, { size: 52, mood: 'idle' }),
        h(SpikeCharacter, { size: 88, mood: 'happy' }),
        h(SpikeCharacter, { size: 68, mood: 'think' }),
      ),
    );
    const masks = [...container.querySelectorAll('mask')];
    const ids = masks.map((m) => m.getAttribute('id'));
    expect(ids.length).toBe(3);
    expect(new Set(ids).size).toBe(3);

    const bodies = [...container.querySelectorAll('path.spike-char__hit')];
    bodies.forEach((body, i) => {
      expect(body.getAttribute('mask')).toBe(`url(#${ids[i]})`);
    });
  });

  it('adds no DOM listeners or observers under prefers-reduced-motion: reduce', () => {
    mockMatchMedia(true, true);
    const winAdd = vi.spyOn(window, 'addEventListener');
    const docAdd = vi.spyOn(document, 'addEventListener');
    const htmlAdd = vi.spyOn(document.documentElement, 'addEventListener');
    const ioSpy = vi.fn();
    const prevIO = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = ioSpy as unknown as typeof IntersectionObserver;

    try {
      const { container } = render(
        h(SpikeCharacter, { mood: 'happy', size: 160, trackPointer: true, allowClickHop: true }),
      );
      const svg = container.querySelector('svg')!;
      expect(svg.getAttribute('data-reduced-motion')).toBe('true');
      expect(svg.getAttribute('data-mood')).toBe('happy');
      expect(winAdd).not.toHaveBeenCalled();
      expect(docAdd).not.toHaveBeenCalled();
      expect(htmlAdd).not.toHaveBeenCalled();
      expect(ioSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.IntersectionObserver = prevIO;
    }
  });

  it('cleans up all listeners, observer, timers and animation frames on unmount', () => {
    vi.useFakeTimers();
    mockMatchMedia(false, true);

    const winAdd = vi.spyOn(window, 'addEventListener');
    const winRemove = vi.spyOn(window, 'removeEventListener');
    const docAdd = vi.spyOn(document, 'addEventListener');
    const docRemove = vi.spyOn(document, 'removeEventListener');
    const htmlAdd = vi.spyOn(document.documentElement, 'addEventListener');
    const htmlRemove = vi.spyOn(document.documentElement, 'removeEventListener');

    const disconnect = vi.fn();
    const observe = vi.fn();
    const prevIO = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      observe = observe;
      unobserve = vi.fn();
      disconnect = disconnect;
    } as unknown as typeof IntersectionObserver;

    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 42);
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    try {
      const { container, unmount } = render(
        h(SpikeCharacter, { mood: 'idle', size: 200, trackPointer: true, allowClickHop: true }),
      );
      expect(observe).toHaveBeenCalledTimes(1);
      expect(winAdd).toHaveBeenCalledWith('pointermove', expect.any(Function), { passive: true });
      expect(docAdd).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
      expect(htmlAdd).toHaveBeenCalledWith('pointerleave', expect.any(Function), { passive: true });

      // Trigger a pointer move so rAF is armed before unmount.
      const svg = container.querySelector('svg')!;
      vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
        left: 100, top: 100, width: 200, height: 200, right: 300, bottom: 300, x: 100, y: 100, toJSON: () => {},
      });
      act(() => {
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 280, clientY: 120 }));
      });
      expect(rafSpy).toHaveBeenCalled();

      unmount();

      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(winRemove).toHaveBeenCalledWith('pointermove', expect.any(Function));
      expect(docRemove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
      expect(htmlRemove).toHaveBeenCalledWith('pointerleave', expect.any(Function));
      expect(cancelSpy).toHaveBeenCalledWith(42);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      globalThis.IntersectionObserver = prevIO;
    }
  });

  it('plays one-shot triggers and click hops, then settles back to the base mood', () => {
    vi.useFakeTimers();
    mockMatchMedia(false, true);

    const onPoke = vi.fn();
    const { container, rerender } = render(
      h(SpikeCharacter, { mood: 'idle', size: 120, allowClickHop: true, onPoke }),
    );
    const svg = container.querySelector('svg')!;
    const hit = container.querySelector('path.spike-char__hit')!;

    fireEvent.click(hit);
    expect(onPoke).toHaveBeenCalledTimes(1);
    expect(svg.getAttribute('data-reaction')).toBe('hop');
    expect(svg.getAttribute('data-mood')).toBe('hop');

    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(svg.getAttribute('data-reaction')).toBeNull();
    expect(svg.getAttribute('data-mood')).toBe('idle');

    rerender(
      h(SpikeCharacter, { mood: 'idle', size: 120, trigger: { kind: 'celebrate', key: 1 } }),
    );
    expect(svg.getAttribute('data-reaction')).toBe('celebrate');
    expect(svg.getAttribute('data-mood')).toBe('celebrate');

    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect(svg.getAttribute('data-reaction')).toBeNull();
    expect(svg.getAttribute('data-mood')).toBe('idle');
  });
});
