// Which install prompt, if any, this browser should see. Pure, so it's tested
// in test/install.test.ts.
//
// - 'prompt': Chrome, Edge and Samsung Internet offer a real install dialog.
// - 'ios': iPhone and iPad have no install API; people use Share, then
//   Add to Home Screen, so we show those steps.
// - 'in-app': Facebook, Instagram and similar in-app browsers can't install
//   at all; we explain how to open the page in a real browser.

export type InstallMode = 'prompt' | 'ios' | 'in-app' | null;

export const DISMISS_DAYS = 14;

const IN_APP = /FBAN|FBAV|FB_IAB|FBIOS|Instagram|LinkedInApp|Snapchat|TikTok|musical_ly|Twitter|Line\//i;
const IOS = /iPhone|iPad|iPod/;

export interface InstallContext {
  ua: string;
  /** Already running as the installed app. */
  standalone: boolean;
  /** The browser has offered an install prompt (beforeinstallprompt). */
  canPrompt: boolean;
  /** iPadOS reports itself as a Mac; a touch screen gives it away. */
  touchMac?: boolean;
  /** When the banner was last closed (ms), or null. */
  dismissedAt: number | null;
  now: number;
}

export function installMode(c: InstallContext): InstallMode {
  if (c.standalone) return null;
  if (c.dismissedAt !== null && c.now - c.dismissedAt < DISMISS_DAYS * 86_400_000) return null;
  if (c.canPrompt) return 'prompt';
  if (IN_APP.test(c.ua)) return 'in-app';
  if (IOS.test(c.ua) || c.touchMac) return 'ios';
  return null;
}
