import { useState, type ComponentProps } from 'react';
import { CalendarDays } from 'lucide-react';
import { Button } from './button';
import { Calendar } from './calendar';
import { Popover, PopoverTrigger, PopoverContent } from './popover';

export function parseCalendarDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : undefined;
}
export function serializeCalendarDate(date: Date): string {
  return `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
}

type Props = Omit<ComponentProps<typeof Button>, 'value' | 'onChange'> & { value: string; onValueChange: (value: string) => void; name?: string };
export function DatePicker({ value, onValueChange, name, className, ...props }: Props) {
  const [open, setOpen] = useState(false);
  const date = parseCalendarDate(value);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button {...props} type="button" variant="outline" className={`input justify-between text-left font-normal ${className ?? ''}`}>
      <span>{date ? date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Pick a date'}</span><CalendarDays size={16} aria-hidden="true" />
    </Button></PopoverTrigger>
    {name && <input type="hidden" name={name} value={value} />}
    <PopoverContent className="w-auto p-0" align="start">
      <Calendar mode="single" selected={date} defaultMonth={date} autoFocus onSelect={d => { onValueChange(d ? serializeCalendarDate(d) : ''); setOpen(false); }} />
      {value && <Button type="button" variant="ghost" className="m-2" onClick={() => { onValueChange(''); setOpen(false); }}>Clear date</Button>}
    </PopoverContent>
  </Popover>;
}
