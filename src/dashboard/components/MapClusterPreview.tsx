import { createPortal } from 'react-dom';
import { Flag } from './Icons';
import { placeName } from '../lib/realtime';

type Place = {
  key: string;
  city: string | null;
  country: string | null;
  count: number;
};
export type Preview = {
  key: string;
  members: Place[];
  total: number;
  x: number;
  y: number;
  width: number;
  maxHeight: number;
};

/** Read-only preview. Selection remains the pin's explicit click/tap action. */
export function MapClusterPreview({ id, preview, onEnter, onLeave }: { id: string; preview: Preview; onEnter: () => void; onLeave: () => void }) {
  return createPortal(
    <div
      id={id}
      role="tooltip"
      className="v3-map-preview"
      style={{
        left: preview.x,
        top: preview.y,
        width: preview.width,
        maxHeight: preview.maxHeight,
      }}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      <div className="v3-map-preview-heading">
        <strong>
          {preview.total} {preview.total === 1 ? 'visitor' : 'visitors'}
        </strong>
        <span>
          {preview.members.length} {preview.members.length === 1 ? 'place' : 'places'}
        </span>
      </div>
      <ul
        style={{
          maxHeight: Math.max(32, Math.min(128, preview.maxHeight - 46)),
        }}
      >
        {preview.members.map((p) => (
          <li key={p.key}>
            <Flag cc={p.country} size={16} />
            <span title={placeName(p.city, p.country) ?? 'Unknown location'}>{placeName(p.city, p.country) ?? 'Unknown location'}</span>
            <b>{p.count}</b>
          </li>
        ))}
      </ul>
    </div>,
    document.body,
  );
}
