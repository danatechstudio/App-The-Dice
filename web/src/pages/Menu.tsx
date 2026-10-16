// Food & Drinks (docs/RTD_FOOD_MENU.md): the café's menu to browse. Text first:
// every line is its name, choices and price, with a photo slot that shows a
// neutral placeholder until the café adds photos. Nothing here takes an order.

import { Info, WifiOff } from 'lucide-preact';
import { useEffect, useRef } from 'preact/hooks';
import { Chip } from '../components/Chips';
import { DiceLoader, EmptyState, ErrorState } from '../components/States';
import { useApi } from '../lib/api';
import { categoryIcon, isSavedCopy, price, type Menu as MenuData, type MenuCategory, type MenuItem } from '../lib/menu';
import { prefersReducedMotion } from '../lib/motion';
import { useCount } from '../lib/stats';
import { useTitle } from '../lib/title';

const savedAt = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(
    new Date(iso),
  );

/**
 * Jump to a section without the in-app router taking the link: scroll, keep the
 * address, and (after a tap on a section link) move focus to its heading.
 */
function jumpTo(id: string, opts: { focus: boolean; behavior?: ScrollBehavior }) {
  const section = document.getElementById(id);
  if (!section) return;
  section.scrollIntoView({ behavior: opts.behavior ?? (prefersReducedMotion() ? 'auto' : 'smooth'), block: 'start' });
  if (opts.focus) section.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  history.replaceState(history.state, '', `#${id}`);
}

export function Menu() {
  useTitle('Food & Drinks');
  useCount('menu_view');
  const { data, error, loading, reload } = useApi<MenuData>('/api/menu');
  const jumped = useRef(false);

  // A link to /menu#hot-drinks opens at that section once the menu has loaded.
  useEffect(() => {
    if (jumped.current || !data?.categories.length) return;
    jumped.current = true;
    let id = '';
    try {
      id = decodeURIComponent(location.hash.slice(1));
    } catch {
      return; // a malformed address: just show the top of the menu
    }
    if (id && data.categories.some(c => c.id === id)) requestAnimationFrame(() => jumpTo(id, { focus: false, behavior: 'auto' }));
  }, [data]);

  return (
    <div class="container menu-page">
      <header class="page-head">
        <p class="label">At the café</p>
        <h1 class="display">Food &amp; Drinks</h1>
        <p class="meta menu-page__intro">Here's what's on our menu. To order, just ask a member of the team. Prices are in pounds.</p>
      </header>

      {loading && !data && <DiceLoader label="Fetching the menu..." />}
      {!data && !loading && <ErrorState error={error} onRetry={reload} />}

      {data && (data.status === 'off' || !data.categories.length) && (
        <div class="card">
          <EmptyState title="The menu isn't in the app just now." text="Ask a member of the team at the café to see what's on today." />
        </div>
      )}

      {data && data.status !== 'off' && data.categories.length > 0 && (
        <>
          {(data.status === 'preview' || isSavedCopy(data)) && (
            <div class="menu-notes">
              {data.status === 'preview' && (
                <p class="preview-note menu-note">
                  <Info size={16} aria-hidden="true" />
                  We're still checking this menu against the board in the café. If a price is different there, the café's price applies.
                </p>
              )}
              {isSavedCopy(data) && (
                <p class="preview-note menu-note" role="status">
                  <WifiOff size={16} aria-hidden="true" />
                  This is a saved copy from {savedAt(data.as_of)}. Prices may have changed since.
                </p>
              )}
            </div>
          )}

          <nav class="menu-jump" aria-label="Menu sections">
            <ul class="filters-scroll" role="list">
              {data.categories.map(c => (
                <li key={c.id}>
                  <a
                    class="filter"
                    href={`#${c.id}`}
                    onClick={e => {
                      e.preventDefault();
                      jumpTo(c.id, { focus: true });
                    }}
                  >
                    {c.name}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div class="menu-sections">
            {data.categories.map(c => (
              <MenuSection key={c.id} c={c} />
            ))}
          </div>

          <aside class="card card--pad menu-allergens" aria-labelledby="menu-allergens">
            <h2 id="menu-allergens" class="menu-allergens__title">
              Allergies and dietary needs
            </h2>
            <p>If you have a food allergy or intolerance, please speak to a member of the team before you order. They can tell you about the ingredients.</p>
          </aside>
        </>
      )}
    </div>
  );
}

function MenuSection({ c }: { c: MenuCategory }) {
  const Icon = categoryIcon(c.id);
  return (
    <section id={c.id} class="section menu-section" aria-labelledby={`${c.id}-title`}>
      {c.image && (
        <div class="menu-section__photo">
          <img src={c.image} alt={c.image_alt ?? ''} loading="lazy" decoding="async" />
        </div>
      )}
      <div class="menu-section__head">
        <span class="menu-section__icon" aria-hidden="true">
          <Icon size={22} strokeWidth={2} />
        </span>
        <div>
          <h2 id={`${c.id}-title`} tabIndex={-1}>
            {c.name}
          </h2>
          {c.description && <p class="meta">{c.description}</p>}
          {c.alcohol && <p class="meta menu-section__age">Alcoholic drinks are for over-18s only.</p>}
        </div>
      </div>
      <ul class="menu-list card" role="list">
        {c.items.map(i => (
          <MenuLine key={i.id} i={i} categoryId={c.id} />
        ))}
      </ul>
    </section>
  );
}

function MenuLine({ i, categoryId }: { i: MenuItem; categoryId: string }) {
  const Icon = categoryIcon(categoryId);
  return (
    <li class={i.available ? 'menu-item' : 'menu-item menu-item--unavailable'}>
      {i.image ? (
        <span class="menu-thumb">
          <img src={i.image} alt={i.image_alt ?? i.name} loading="lazy" decoding="async" width={64} height={64} />
        </span>
      ) : (
        <span class="menu-thumb menu-thumb--empty" aria-hidden="true">
          <Icon size={24} strokeWidth={1.75} />
        </span>
      )}
      <div class="menu-item__body">
        <h3 class="menu-item__name">{i.name}</h3>
        {i.options && <p class="menu-item__options">{i.options}</p>}
        {i.description && <p class="meta">{i.description}</p>}
        {(i.alcohol || !i.available) && (
          <p class="cluster menu-item__chips">
            {i.alcohol && (
              <Chip kind="age">
                18+<span class="visually-hidden">, alcoholic</span>
              </Chip>
            )}
            {!i.available && <Chip kind="completed">Not available right now</Chip>}
          </p>
        )}
      </div>
      <Price i={i} />
    </li>
  );
}

function Price({ i }: { i: MenuItem }) {
  if (!i.prices.length) return <p class="menu-price menu-price--note">{i.price_note ?? 'Ask at the counter'}</p>;
  if (i.prices.length === 1 && i.prices[0]!.label === null) return <p class="menu-price">{price(i.prices[0]!.price_pence)}</p>;
  return (
    <dl class="menu-price menu-price--sizes">
      {i.prices.map(p => (
        <div key={p.label}>
          <dt>{p.label}</dt>
          <dd>{price(p.price_pence)}</dd>
        </div>
      ))}
    </dl>
  );
}
