import '@fontsource/arvo/700.css';
import '@fontsource-variable/figtree/wght.css';
import 'virtual:rtd-theme.css';
import './styles/base.css';
import './styles/components.css';
import './styles/shell.css';
import './styles/pages.css';
import './styles/roll.css';
import './styles/surfaces.css';
import { render } from 'preact';
import { App } from './app';
import { applyMotionPreference } from './lib/motion';
import { installLinkInterception } from './lib/router';
import { count } from './lib/stats';

applyMotionPreference();
installLinkInterception();
render(<App />, document.getElementById('app')!);

// Stats: each time the app opens, from the Home Screen (installed) or in a browser.
const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
count(standalone ? 'home_screen_open' : 'app_open');

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => undefined));
}
