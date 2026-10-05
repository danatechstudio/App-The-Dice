import { CalendarDays, ChessKnight, Dices, House, Ticket } from 'lucide-preact';
import { Logo } from './Brand';

const ITEMS = [
  { href: '/', label: 'Home', icon: House },
  { href: '/diary', label: 'Diary', icon: CalendarDays },
  { href: '/roll', label: 'Roll', icon: Dices, roll: true },
  { href: '/book', label: 'Book', icon: Ticket },
  { href: '/games', label: 'Games', icon: ChessKnight },
] as const;

function section(path: string): string {
  if (path === '/') return '/';
  if (path.startsWith('/event')) return '/diary';
  if (path.startsWith('/host') || path.startsWith('/organise')) return '/book';
  return `/${path.split('/')[1] ?? ''}`;
}

export function TopBar({ path }: { path: string }) {
  const current = section(path);
  return (
    <header class={path === '/' ? 'topbar topbar--home' : 'topbar'}>
      <div class="container topbar__inner">
        <a class="topbar__logo" href="/" aria-label="Roll The Dice home">
          <Logo eager />
        </a>
        <nav class="topnav" aria-label="Main">
          {ITEMS.filter(i => !('roll' in i)).map(i => (
            <a key={i.href} href={i.href} aria-current={current === i.href ? 'page' : undefined}>
              {i.label}
            </a>
          ))}
          <a class="btn btn--roll btn--sm" href="/roll" aria-current={current === '/roll' ? 'page' : undefined}>
            <Dices class="wiggle" size={18} aria-hidden="true" />
            Roll Me a Game
          </a>
        </nav>
      </div>
    </header>
  );
}

export function BottomNav({ path }: { path: string }) {
  const current = section(path);
  return (
    <nav class="bottomnav" aria-label="Main">
      <ul>
        {ITEMS.map(({ href, label, icon: Icon, ...rest }) => (
          <li key={href}>
            <a
              href={href}
              class={'roll' in rest ? 'bottomnav__roll' : undefined}
              aria-current={current === href ? 'page' : undefined}
            >
              <span class="bottomnav__icon">
                <Icon size={'roll' in rest ? 30 : 22} strokeWidth={'roll' in rest ? 2 : 2.25} aria-hidden="true" />
              </span>
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
