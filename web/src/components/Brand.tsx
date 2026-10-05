// The logo is only ever shown on brand navy, exactly as in the reference
// (white sticker lettering on #123F68). The dice mark is for small places.

export function Logo({ class: cls, eager }: { class?: string; eager?: boolean }) {
  return (
    <img
      class={cls}
      src="/brand/rtd-logo.webp"
      width={960}
      height={340}
      alt="Roll The Dice Board Game Café"
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
    />
  );
}

export function DiceMark({ class: cls, alt = '' }: { class?: string; alt?: string }) {
  return <img class={cls} src="/brand/rtd-dice-mark.webp" width={480} height={317} alt={alt} loading="lazy" decoding="async" />;
}
