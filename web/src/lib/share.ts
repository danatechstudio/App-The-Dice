import type { ShareData } from './shareLinks';
import { toast } from './toast';

/** Copy the link, saying where to paste it. */
export async function copyLink(url: string, where?: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    toast(where ? `Link copied. Paste it into ${where}.` : 'Link copied. Paste it anywhere to share.');
  } catch {
    toast(`Share this link: ${url}`);
  }
}

/**
 * The phone's own share sheet (where Instagram, Discord and the rest appear if
 * installed); where there isn't one, or it fails, copy the link instead.
 */
export async function viaPhoneOrCopy(data: ShareData, where: string): Promise<void> {
  if (navigator.share) {
    try {
      await navigator.share(data);
      return;
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return; // closed the share sheet
    }
  }
  await copyLink(data.url, where);
}
