// Share an event: WhatsApp, Facebook, Instagram, Discord, X, email, text, copy
// the link, or the phone's own share sheet. A panel that slides up on phones
// and sits in the middle on computers; Esc, the backdrop or a choice closes it.

import { AtSign, Camera, Copy, Gamepad2, Mail, MessageCircle, MessageSquareText, Share2, ThumbsUp, X } from 'lucide-preact';
import type { LucideIcon } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { copyLink, viaPhoneOrCopy } from '../lib/share';
import { shareLinks, type ShareData } from '../lib/shareLinks';
import { count } from '../lib/stats';

type Item = { label: string; Icon: LucideIcon; href: string } | { label: string; Icon: LucideIcon; run: () => void };

let nextId = 0;

export function ShareMenu({ data, eventId, compact }: { data: ShareData; eventId?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [id] = useState(() => `share-${++nextId}`);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>('.share-sheet__list a, .share-sheet__list button')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const links = shareLinks(data);
  const tapped = () => {
    if (eventId) count('share_tap', eventId);
    setOpen(false);
  };
  const items: Item[] = [
    { label: 'WhatsApp', Icon: MessageCircle, href: links.whatsapp },
    { label: 'Facebook', Icon: ThumbsUp, href: links.facebook },
    {
      label: 'Instagram',
      Icon: Camera,
      run: () => viaPhoneOrCopy(data, 'your Instagram story or message'),
    },
    {
      label: 'Discord',
      Icon: Gamepad2,
      run: () => viaPhoneOrCopy(data, 'a Discord chat'),
    },
    { label: 'X (Twitter)', Icon: AtSign, href: links.x },
    { label: 'Email', Icon: Mail, href: links.email },
    { label: 'Text message', Icon: MessageSquareText, href: links.sms },
    { label: 'Copy link', Icon: Copy, run: () => copyLink(data.url) },
  ];
  if (typeof navigator !== 'undefined' && 'share' in navigator)
    items.push({
      label: 'More…',
      Icon: Share2,
      run: () => viaPhoneOrCopy(data, 'any app'),
    });

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class={compact ? 'btn btn--icon btn--text share-trigger' : 'btn btn--secondary'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={compact ? `Share ${data.title}` : undefined}
        onClick={e => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Share2 size={18} aria-hidden="true" />
        {!compact && ' Share'}
      </button>
      {open && (
        <div class="share-sheet" onClick={e => e.target === e.currentTarget && close()}>
          <div ref={panel} class="share-sheet__panel" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
            <div class="share-sheet__head">
              <h2 id={`${id}-title`} class="share-sheet__title">
                Share <span>{data.title}</span>
              </h2>
              <button type="button" class="btn btn--icon btn--text" onClick={close} aria-label="Close">
                <X size={20} aria-hidden="true" />
              </button>
            </div>
            <ul class="share-sheet__list">
              {items.map(({ label, Icon, ...action }) => (
                <li key={label}>
                  {'href' in action ? (
                    <a href={action.href} target="_blank" rel="noopener" onClick={tapped}>
                      <Icon size={20} aria-hidden="true" /> {label}
                    </a>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        tapped();
                        action.run();
                      }}
                    >
                      <Icon size={20} aria-hidden="true" /> {label}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
