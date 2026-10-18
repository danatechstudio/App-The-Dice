import { describe, expect, it } from 'vitest';
import { eventShare, shareLinks } from '../web/src/lib/shareLinks';

const data = { title: 'Quiz & Pizza', text: 'Quiz & Pizza at Roll The Dice, Fri 23 Oct', url: 'https://rtd.example/event/RTD-OCC-00001-20261023' };

describe('share links', () => {
  const links = shareLinks(data);

  it('opens WhatsApp with the message and the link', () => {
    const u = new URL(links.whatsapp);
    expect(u.origin + u.pathname).toBe('https://wa.me/');
    expect(u.searchParams.get('text')).toBe(`${data.text} ${data.url}`);
  });

  it('gives Facebook just the link, so it shows the event’s own preview', () => {
    const u = new URL(links.facebook);
    expect(u.origin + u.pathname).toBe('https://www.facebook.com/sharer/sharer.php');
    expect(u.searchParams.get('u')).toBe(data.url);
  });

  it('fills in X with the message and the link', () => {
    const u = new URL(links.x);
    expect(u.origin + u.pathname).toBe('https://twitter.com/intent/tweet');
    expect(u.searchParams.get('text')).toBe(data.text);
    expect(u.searchParams.get('url')).toBe(data.url);
  });

  it('starts an email with the event as the subject', () => {
    expect(links.email.startsWith('mailto:?')).toBe(true);
    const q = new URLSearchParams(links.email.slice('mailto:?'.length));
    expect(q.get('subject')).toBe(data.title);
    expect(q.get('body')).toBe(`${data.text}\n\n${data.url}`);
  });

  it('starts a text message with the message and the link', () => {
    expect(links.sms.startsWith('sms:?&body=')).toBe(true);
    expect(decodeURIComponent(links.sms.slice('sms:?&body='.length))).toBe(`${data.text} ${data.url}`);
  });

  it('encodes awkward characters instead of breaking the link', () => {
    const odd = shareLinks({ title: 'A&B #1 ?', text: 'A&B #1 ? 100%', url: 'https://rtd.example/event/x?y=1&z=2' });
    expect(new URL(odd.whatsapp).searchParams.get('text')).toBe('A&B #1 ? 100% https://rtd.example/event/x?y=1&z=2');
    expect(new URL(odd.facebook).searchParams.get('u')).toBe('https://rtd.example/event/x?y=1&z=2');
  });

  it('leaves out the text when there is none', () => {
    const bare = shareLinks({ title: 'Quiz', url: data.url });
    expect(new URL(bare.whatsapp).searchParams.get('text')).toBe(data.url);
    expect(new URLSearchParams(bare.email.slice('mailto:?'.length)).get('body')).toBe(data.url);
  });

  it('describes an event the same way everywhere it is shared', () => {
    expect(eventShare({ name: 'Quiz', date: '2026-10-23', occurrence_id: 'RTD-OCC-00001-20261023' }, 'https://rtd.example')).toEqual({
      title: 'Quiz',
      text: 'Quiz at Roll The Dice, Fri 23 Oct',
      url: 'https://rtd.example/event/RTD-OCC-00001-20261023',
    });
  });
});
