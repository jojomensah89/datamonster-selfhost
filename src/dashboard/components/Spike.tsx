import { useId } from 'react';

/** Spike, the DataMonster mascot: a revenue spike with eyes. Coloured by `currentColor`. */
export function Spike({ size, className }: { size: number; className?: string }) {
  const maskId = useId();
  return (
    <svg aria-hidden="true" className={className ? `spike-icon ${className}` : 'spike-icon'} width={size} height={size} viewBox="923.2 231.2 217.6 217.6">
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="923.2" y="231.2" width="217.6" height="217.6">
          <rect x="923.2" y="231.2" width="217.6" height="217.6" fill="white" />
          <path
            className="spike-icon__eye"
            d="M 990.5,354 Q 990.5,340 1004.5,340 Q 1018.5,340 1018.5,354
              V 367.5 Q 1018.5,381.5 1004.5,381.5 Q 990.5,381.5 990.5,367.5 Z"
          />
          <path
            className="spike-icon__eye spike-icon__eye--right"
            d="M 1038.5,349 Q 1038.5,336.5 1054,336.5 Q 1070,336.5 1070,350
              V 363 Q 1070,374.5 1055.5,374.5 Q 1038.5,374.5 1038.5,363 Z"
          />
        </mask>
      </defs>
      <path
        fill="currentColor"
        mask={`url(#${maskId})`}
        d="M 1018,265 Q 1024,255 1030,265 L 1052.5,312.5
          C 1080,317 1100,329 1108.5,356 C 1118,382 1117,403 1097,415.5
          H 978 C 961,415.5 956.5,402 956.5,381 C 956.5,359 964,342 977,325 Z"
      />
    </svg>
  );
}
