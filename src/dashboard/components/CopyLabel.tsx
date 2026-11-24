import { Icon } from './ui';

/** An icon with a name for screen readers. */
export const CopyLabel = ({ icon, text }: { icon: string; text: string }) => (
  <>
    <Icon name={icon} />
    <span className="sr-only">{text}</span>
  </>
);
