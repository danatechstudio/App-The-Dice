import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { Footer } from './components/Footer';
import { InstallBanner, InstallHelp } from './components/Install';
import { BottomNav, TopBar } from './components/Nav';
import { Splash, markSplashShown, pickSplash, splashSeenThisSession } from './components/Splash';
import { Toaster } from './components/Toaster';
import type { Occurrence } from './lib/api';
import { useUpcoming } from './lib/events';
import { match, usePath } from './lib/router';
import { Book } from './pages/Book';
import { Diary } from './pages/Diary';
import { EventPage, SeriesPage } from './pages/Event';
import { Games } from './pages/Games';
import { Home } from './pages/Home';
import { Host } from './pages/Host';
import { ManageBooking } from './pages/ManageBooking';
import { NotFound } from './pages/NotFound';
import { Organise } from './pages/Organise';
import { Roll } from './pages/Roll';
import { StyleGuide } from './pages/StyleGuide';

function route(path: string) {
  let p: Record<string, string> | null;
  if (path === '/') return <Home />;
  if (path === '/diary') return <Diary />;
  if (path === '/roll') return <Roll />;
  if (path === '/book') return <Book />;
  if (path === '/games') return <Games />;
  if (path === '/host') return <Host />;
  if (path === '/organise') return <Organise />;
  if (path === '/styleguide') return <StyleGuide />;
  if ((p = match('/event/:id', path))) return <EventPage key={p.id} occurrenceId={p.id!} />;
  if ((p = match('/events/:id', path))) return <SeriesPage key={p.id} eventId={p.id!} />;
  if ((p = match('/booking/:id', path))) return <ManageBooking key={p.id} bookingId={p.id!} />;
  return <NotFound />;
}

export function App() {
  const path = usePath();
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);

  // Move focus to the new screen for keyboard and screen-reader users.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus({ preventScroll: true });
  }, [path]);

  return (
    <>
      <a class="skip-link" href="#main">Skip to content</a>
      <InstallBanner />
      <TopBar path={path} />
      <main id="main" ref={main} tabIndex={-1} class={path === '/roll' ? 'main--flush' : undefined}>
        {route(path)}
      </main>
      {path !== '/roll' && <Footer />}
      <BottomNav path={path} />
      <Toaster />
      <InstallHelp />
      <LaunchSplash path={path} />
    </>
  );
}

/** The promotional splash, once per visit, only when the app opens on Home. */
function LaunchSplash({ path }: { path: string }) {
  const [opened] = useState(() => path === '/' && !splashSeenThisSession() && !new URLSearchParams(location.search).has('nosplash'));
  const { occurrences, today } = useUpcoming();
  const [chosen, setChosen] = useState<Occurrence | null | undefined>(undefined);

  useEffect(() => {
    if (!opened || chosen !== undefined || !occurrences) return;
    const pick = pickSplash(occurrences, today);
    if (pick) markSplashShown(pick);
    setChosen(pick);
  }, [opened, occurrences, chosen, today]);

  const close = useCallback(() => setChosen(null), []);
  return chosen ? <Splash o={chosen} onClose={close} /> : null;
}
