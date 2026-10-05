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

applyMotionPreference();
installLinkInterception();
render(<App />, document.getElementById('app')!);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => undefined));
}
