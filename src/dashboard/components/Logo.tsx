import { Spike } from './Spike';

/** The DataMonster mark and name. */
export function Logo({ small = false }: { small?: boolean }) {
  const size = small ? 24 : 28;
  return (
    <div className="flex items-center gap-2.5">
      <Spike size={size} />
      <span className={`font-semibold tracking-[-0.01em] text-ink ${small ? 'text-[15px]' : 'text-base'}`}>DataMonster</span>
    </div>
  );
}
