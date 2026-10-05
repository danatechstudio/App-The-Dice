import { toast } from './toast';

export async function share(data: { title: string; text?: string; url: string }): Promise<void> {
  if (navigator.share) {
    try {
      await navigator.share(data);
      return;
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return; // closed the share sheet
    }
  }
  try {
    await navigator.clipboard.writeText(data.url);
    toast('Link copied. Paste it anywhere to share.');
  } catch {
    toast(`Share this link: ${data.url}`);
  }
}
