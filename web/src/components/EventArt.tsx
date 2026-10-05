import type { ComponentChildren } from 'preact';
import type { Category } from '../lib/api';
import { CATEGORY } from '../lib/categories';

// Stickers sit at slightly different angles, like dice that have just landed.
const TILTS = [-8, -4, 5, 8, -6, 3];
const tiltFor = (seed: string) => TILTS[[...seed].reduce((n, ch) => n + ch.charCodeAt(0), 0) % TILTS.length];

/** Event artwork, or the branded fallback when the event has no poster yet. */
export function EventArt({ image, category, children, eager, seed = category }: {
  image: string | null;
  category: Category;
  children?: ComponentChildren;
  eager?: boolean;
  /** Varies the fallback sticker's angle; pass the event id. */
  seed?: string;
}) {
  const Icon = CATEGORY[category]?.icon ?? CATEGORY.Other.icon;
  return (
    <div class={`art ${image ? 'art--shade' : 'art--fallback'}`}>
      {image ? (
        <img src={image} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" />
      ) : (
        <div class="art__sticker" style={{ '--tilt': `${tiltFor(seed)}deg` }}>
          <Icon strokeWidth={2} aria-hidden="true" />
        </div>
      )}
      {children && <div class="art__chips">{children}</div>}
    </div>
  );
}
