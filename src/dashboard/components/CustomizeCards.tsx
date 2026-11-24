import { GripVertical, SlidersHorizontal } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { CARDS, DEFAULT_CARDS, isDefaultCards, type CardId, type CardPref } from '../../shared/dashboardCards';
import { Button } from './primitives/button';
import { Popover, PopoverContent, PopoverTrigger } from './primitives/popover';
import { Switch } from './primitives/switch';

const ROW = 40;
const labelOf = (id: CardId) => CARDS.find((c) => c.id === id)!.label;
const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));

/** Which cards the Overview shows and in what order. */
export function CustomizeCards({
  cards,
  onChange,
  open,
  onOpenChange,
  error,
  triggerRef,
}: {
  cards: CardPref[];
  onChange: (c: CardPref[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  error?: string;
  triggerRef?: RefObject<HTMLButtonElement>;
}) {
  const list = useRef<HTMLUListElement>(null);
  // The rows stay where they are in the page while one is dragged (moving it would end the drag); they only shift.
  const [drag, setDrag] = useState<{ id: CardId; from: number; startY: number; startScroll: number; dy: number } | null>(null);
  const [said, setSaid] = useState('');
  const refocus = useRef<CardId | null>(null);
  const hidden = cards.filter((c) => !c.on).length;
  const to = drag ? clamp(drag.from + Math.round(drag.dy / ROW), cards.length - 1) : -1;

  const move = (id: CardId, at: number) => {
    const from = cards.findIndex((c) => c.id === id);
    if (at < 0 || at >= cards.length || at === from) return;
    const next = [...cards];
    next.splice(at, 0, next.splice(from, 1)[0]);
    refocus.current = id;
    setSaid(`${labelOf(id)} is now ${at + 1} of ${cards.length}`);
    onChange(next);
  };

  useLayoutEffect(() => {
    if (!refocus.current) return;
    list.current?.querySelector<HTMLElement>(`[data-card="${refocus.current}"] button`)?.focus();
    refocus.current = null;
  }, [cards]);

  const onDown = (e: PointerEvent<HTMLButtonElement>, id: CardId, from: number) => {
    if (e.button !== 0 || drag) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id, from, startY: e.clientY, startScroll: list.current!.scrollTop, dy: 0 });
  };
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const el = list.current!;
    const box = el.getBoundingClientRect();
    if (e.clientY < box.top + ROW / 2) el.scrollTop -= 8;
    else if (e.clientY > box.bottom - ROW / 2) el.scrollTop += 8;
    const dy = e.clientY - drag.startY + el.scrollTop - drag.startScroll;
    setDrag({ ...drag, dy: clamp(dy + drag.from * ROW, (cards.length - 1) * ROW) - drag.from * ROW });
  };
  const onUp = () => {
    if (!drag) return;
    setDrag(null);
    move(drag.id, to);
  };
  const onKey = (e: KeyboardEvent, id: CardId, i: number) => {
    const d = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (!d) return;
    e.preventDefault();
    if (!drag) move(id, i + d);
  };

  const shift = (i: number) => {
    if (!drag) return undefined;
    if (i === drag.from) return { transform: `translateY(${drag.dy}px)` };
    const by = i > drag.from && i <= to ? -ROW : i < drag.from && i >= to ? ROW : 0;
    return { transform: `translateY(${by}px)` };
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button ref={triggerRef} variant="raw" size="raw" type="button" className="icon-btn relative" aria-label={hidden ? `Choose cards, ${hidden} hidden` : 'Choose cards'} title="Choose cards">
          <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
          {hidden > 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={12}
        aria-label="Choose cards"
        className="flex max-h-[var(--radix-popover-content-available-height)] w-[300px] max-w-[calc(100vw-24px)] flex-col border-line p-2"
        onEscapeKeyDown={(e) => {
          if (!drag) return;
          e.preventDefault();
          setDrag(null);
        }}
      >
        <div className="flex h-9 shrink-0 items-center justify-between px-2">
          <h2 className="text-sm font-medium">Cards</h2>
          <Button variant="raw" size="raw" type="button" className="card-link h-8 text-sm disabled:text-faint disabled:no-underline" disabled={isDefaultCards(cards)} onClick={() => onChange(DEFAULT_CARDS.map((c) => ({ ...c })))}>
            Reset
          </Button>
        </div>
        {error && (
          <p role="alert" className="shrink-0 px-2 pb-2 text-xs text-negative">
            {error}
          </p>
        )}
        <span id="card-move-help" className="sr-only">
          Press the up or down arrow key to move it
        </span>
        <ul ref={list} aria-label="Cards" className="min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain">
          {cards.map((c, i) => {
            const label = labelOf(c.id);
            const dragged = drag?.id === c.id;
            return (
              <li
                key={c.id}
                data-card={c.id}
                style={shift(i)}
                className={`relative flex h-10 items-center gap-1 rounded-lg pr-2 ${dragged ? 'z-10 bg-raised' : drag ? 'transition-transform duration-150' : ''}`}
              >
                <Button
                  variant="raw"
                  size="raw"
                  type="button"
                  className="grid h-10 w-8 shrink-0 cursor-grab touch-none place-items-center rounded-lg text-faint -outline-offset-2 hover:text-ink active:cursor-grabbing"
                  aria-label={`Move ${label}`}
                  aria-describedby="card-move-help"
                  onPointerDown={(e) => onDown(e, c.id, i)}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onPointerCancel={() => setDrag(null)}
                  onKeyDown={(e) => onKey(e, c.id, i)}
                >
                  <GripVertical className="h-4 w-4" aria-hidden="true" />
                </Button>
                <label htmlFor={`card-${c.id}`} className={`flex h-10 min-w-0 flex-1 cursor-pointer items-center text-sm ${c.on ? '' : 'text-muted'}`}>
                  <span className="truncate">{label}</span>
                </label>
                <Switch id={`card-${c.id}`} checked={c.on} onCheckedChange={(on) => onChange(cards.map((x) => (x.id === c.id ? { ...x, on } : x)))} />
              </li>
            );
          })}
        </ul>
        <span role="status" className="sr-only">
          {said}
        </span>
      </PopoverContent>
    </Popover>
  );
}
