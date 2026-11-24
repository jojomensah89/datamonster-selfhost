import type { ComponentProps, ReactNode } from 'react';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem as Item } from './select';

// Encode every value, including the intentional empty choice. Radix reserves an empty item value.
export const encodeSelectValue = (value: string) => JSON.stringify(value);
export const decodeSelectValue = (value: string) => JSON.parse(value) as string;

export function SelectItem({ value, children, ...props }: Omit<ComponentProps<typeof Item>, 'value'> & { value: string; children: ReactNode }) {
  return <Item {...props} value={encodeSelectValue(value)}>{children}</Item>;
}

// Application forms submit their decoded state explicitly; this field has no native form API.
type Props = Omit<ComponentProps<typeof SelectTrigger>, 'value' | 'onChange' | 'name'> & {
  value?: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  placeholder?: string;
};

export function SelectField({ value = '', onValueChange, children, placeholder = 'Select', disabled, ...trigger }: Props) {
  return <Select value={encodeSelectValue(value)} onValueChange={v => onValueChange(decodeSelectValue(v))} disabled={disabled}>
    <SelectTrigger {...trigger}><SelectValue placeholder={placeholder} /></SelectTrigger>
    <SelectContent position="popper">{children}</SelectContent>
  </Select>;
}
