import { describe, expect, it } from 'vitest';
import { DISMISS_DAYS, installMode, type InstallContext } from '../web/src/lib/install-mode';

const UA = {
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36',
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iphoneFacebook: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0]',
  androidInstagram: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36 Instagram 350.0',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  desktopFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
};
const NOW = Date.UTC(2026, 9, 5, 12);
const ctx = (over: Partial<InstallContext>): InstallContext => ({ ua: UA.androidChrome, standalone: false, canPrompt: false, dismissedAt: null, now: NOW, ...over });

describe('install banner', () => {
  it('offers the real install dialog where the browser has one', () => {
    expect(installMode(ctx({ canPrompt: true }))).toBe('prompt');
  });

  it('shows Add to Home Screen steps on iPhone and iPad', () => {
    expect(installMode(ctx({ ua: UA.iphoneSafari }))).toBe('ios');
    expect(installMode(ctx({ ua: UA.macSafari, touchMac: true }))).toBe('ios'); // iPadOS
    expect(installMode(ctx({ ua: UA.macSafari }))).toBeNull(); // a real Mac
  });

  it('tells people in Facebook or Instagram to open a real browser', () => {
    expect(installMode(ctx({ ua: UA.iphoneFacebook }))).toBe('in-app');
    expect(installMode(ctx({ ua: UA.androidInstagram }))).toBe('in-app');
  });

  it('stays hidden where it cannot help, or once installed', () => {
    expect(installMode(ctx({ ua: UA.desktopFirefox }))).toBeNull();
    expect(installMode(ctx({ ua: UA.androidChrome }))).toBeNull(); // no prompt offered (yet)
    expect(installMode(ctx({ canPrompt: true, standalone: true }))).toBeNull();
    expect(installMode(ctx({ ua: UA.iphoneSafari, standalone: true }))).toBeNull();
  });

  it(`stays away for ${DISMISS_DAYS} days after "Not now"`, () => {
    const day = 86_400_000;
    expect(installMode(ctx({ canPrompt: true, dismissedAt: NOW - day }))).toBeNull();
    expect(installMode(ctx({ canPrompt: true, dismissedAt: NOW - (DISMISS_DAYS + 1) * day }))).toBe('prompt');
  });
});
