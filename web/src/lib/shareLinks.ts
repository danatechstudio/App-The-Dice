// Where an event can be shared (components/ShareMenu). Apps that take a link
// in the address get one; Instagram and Discord have no such address, so the
// menu hands those to the phone's own share sheet or copies the link.

import { shortDate } from './dates';

export interface ShareData {
  title: string;
  text?: string;
  url: string;
}

const enc = encodeURIComponent;

export function shareLinks(d: ShareData) {
  const message = d.text ? `${d.text} ${d.url}` : d.url;
  return {
    whatsapp: `https://wa.me/?text=${enc(message)}`,
    // Facebook reads the page itself, so the link shows the event's own preview card.
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${enc(d.url)}`,
    x: `https://twitter.com/intent/tweet?text=${enc(d.text ?? d.title)}&url=${enc(d.url)}`,
    email: `mailto:?subject=${enc(d.title)}&body=${enc(d.text ? `${d.text}\n\n${d.url}` : d.url)}`,
    // "sms:?&body=" opens the composer with the body on both Android and iPhone.
    sms: `sms:?&body=${enc(message)}`,
  };
}

/** One event, described the same way on its page, in the diary and on Home. */
export function eventShare(o: { name: string; date: string; occurrence_id: string }, origin: string): ShareData {
  return { title: o.name, text: `${o.name} at Roll The Dice, ${shortDate(o.date)}`, url: `${origin}/event/${o.occurrence_id}` };
}
