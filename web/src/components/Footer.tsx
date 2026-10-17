import { useState } from 'preact/hooks';
import { prefersReducedMotion, setReducedMotion } from '../lib/motion';
import { DiceMark } from './Brand';
import { InstallLink } from './Install';

export function Footer() {
  const [reduced, setReduced] = useState(prefersReducedMotion());
  return (
    <footer class="footer">
      <div class="container footer__inner">
        <div class="footer__brand">
          <DiceMark />
          <span>Roll The Dice Board Game Café</span>
        </div>
        <div class="cluster">
          <a class="footer__link" href="/menu">
            Food &amp; Drinks
          </a>
          <a class="footer__link" href="/markets">
            Markets
          </a>
          <a class="footer__link" href="/privacy">
            Privacy
          </a>
          <InstallLink />
          <button
            type="button"
            class="switch"
            role="switch"
            aria-checked={reduced}
            onClick={() => {
              setReducedMotion(!reduced);
              setReduced(!reduced);
            }}
          >
            <span class="switch__track" aria-hidden="true" />
            Reduce motion
          </button>
        </div>
        <p class="footer__credit">
          App designed and built by{' '}
          <a href="https://atechstudio.co.uk" rel="noopener" target="_blank">
            atechstudio.co.uk
          </a>
        </p>
      </div>
    </footer>
  );
}
