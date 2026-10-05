import { ChevronLeft, ChevronRight, X } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';

/** "From past sessions": the event's photos, opening full screen. */
export function Gallery({ images, name }: { images: string[]; name: string }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!images.length) return null;
  return (
    <section class="gallery" aria-labelledby="gallery-title">
      <h2 id="gallery-title" class="label">From past sessions</h2>
      <ul class="gallery__grid" role="list">
        {images.map((src, i) => (
          <li key={src}>
            <button type="button" class="gallery__thumb" onClick={() => setOpen(i)} aria-label={`Open photo ${i + 1} of ${images.length}`}>
              <img src={src} alt="" loading="lazy" decoding="async" />
            </button>
          </li>
        ))}
      </ul>
      {open !== null && <Lightbox images={images} start={open} name={name} onClose={() => setOpen(null)} />}
    </section>
  );
}

function Lightbox({ images, start, name, onClose }: { images: string[]; start: number; name: string; onClose: () => void }) {
  const [i, setI] = useState(start);
  const close = useRef<HTMLButtonElement>(null);
  const n = images.length;
  const go = (d: number) => setI(x => (x + d + n) % n);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') go(1);
      if (e.key === 'ArrowLeft') go(-1);
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previous?.focus?.();
    };
  }, []);

  // Swipe left/right on phones.
  const touch = useRef<number | null>(null);
  return (
    <div
      class="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`${name}: photo ${i + 1} of ${n}`}
      onClick={e => e.target === e.currentTarget && onClose()}
      onTouchStart={e => (touch.current = e.touches[0]?.clientX ?? null)}
      onTouchEnd={e => {
        const end = e.changedTouches[0]?.clientX;
        if (touch.current !== null && end !== undefined && Math.abs(end - touch.current) > 50) go(end < touch.current ? 1 : -1);
        touch.current = null;
      }}
    >
      <img class="lightbox__img" src={images[i]} alt={`${name}, photo ${i + 1} of ${n}`} />
      <button ref={close} type="button" class="btn btn--icon btn--outline-inverse lightbox__close" onClick={onClose} aria-label="Close photo">
        <X size={22} aria-hidden="true" />
      </button>
      {n > 1 && (
        <>
          <button type="button" class="btn btn--icon btn--outline-inverse lightbox__prev" onClick={() => go(-1)} aria-label="Previous photo">
            <ChevronLeft size={24} aria-hidden="true" />
          </button>
          <button type="button" class="btn btn--icon btn--outline-inverse lightbox__next" onClick={() => go(1)} aria-label="Next photo">
            <ChevronRight size={24} aria-hidden="true" />
          </button>
          <p class="lightbox__count" aria-hidden="true">
            {i + 1} / {n}
          </p>
        </>
      )}
    </div>
  );
}
