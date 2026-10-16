// The food and drinks menu in the organiser, for admins (docs/RTD_FOOD_MENU.md):
// Off, Preview or Live; how the latest copy from the RTD Food Menu sheet went;
// and every line next to its menu wording, for checking against the board in
// the café. The menu itself is edited in the sheet.

import { ExternalLink } from 'lucide-preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { Chip } from '../components/Chips';
import { DiceLoader } from '../components/States';
import { hostApi } from '../lib/hostApi';
import { price, type MenuItem, type MenuStatus } from '../lib/menu';
import { toast } from '../lib/toast';

interface AdminMenu {
  status: MenuStatus;
  status_changed_at: string | null;
  status_changed_by: string | null;
  counts: { categories: number; items: number; hidden: number; unavailable: number; no_price: number };
  sheet: { url: string | null; changed_at: string | null; checked_at: string | null; ok: boolean | null; errors: string[] };
  categories: { id: string; name: string; visible: boolean; items: (MenuItem & { shown: boolean; source_text: string })[] }[];
}

const STATUS: Record<MenuStatus, { label: string; chip: 'live' | 'preview' | 'draft'; ask: string; done: string }> = {
  off: {
    label: 'Off',
    chip: 'draft',
    ask: 'Take the menu out of the app? The Food & Drinks page will say the menu isn’t in the app just now.',
    done: 'The menu is off.',
  },
  preview: {
    label: 'Preview',
    chip: 'preview',
    ask: 'Show the menu as a preview? Everyone can see it, with a note that prices are still being checked and the café’s price applies.',
    done: 'The menu is showing as a preview.',
  },
  live: {
    label: 'Live',
    chip: 'live',
    ask: 'Put the menu live? Only do this once every price has been checked against the board in the café. The “still checking” note goes.',
    done: 'The menu is live.',
  },
};

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

const priceText = (i: MenuItem) =>
  i.prices.length ? i.prices.map(p => (p.label ? `${p.label} ${price(p.price_pence)}` : price(p.price_pence))).join(', ') : (i.price_note ?? 'No price');

export function MenuAdmin() {
  const [data, setData] = useState<AdminMenu | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const res = await hostApi<AdminMenu>('/api/staff/menu');
    if (res.ok) setData(res.data);
    else toast(res.error);
  }, []);
  useEffect(() => void load(), [load]);

  const switchTo = async (status: MenuStatus) => {
    if (!data || status === data.status || !confirm(STATUS[status].ask)) return;
    setBusy(true);
    const res = await hostApi('/api/staff/menu/status', { status });
    setBusy(false);
    toast(res.ok ? STATUS[status].done : res.error);
    await load();
  };

  return (
    <section class="section" aria-labelledby="menu-admin">
      <div class="section-head">
        <h2 id="menu-admin">Food &amp; drinks menu</h2>
        {data && <Chip kind={STATUS[data.status].chip}>{STATUS[data.status].label}</Chip>}
      </div>
      {!data && <DiceLoader label="Loading the menu..." />}
      {data && (
        <div class="card card--pad stack" style={{ '--gap': '12px' }}>
          <p class="meta">
            {data.counts.items} lines in {data.counts.categories} sections; {data.counts.no_price} with no single price (they say why instead)
            {data.counts.hidden > 0 && `; ${data.counts.hidden} hidden`}
            {data.counts.unavailable > 0 && `; ${data.counts.unavailable} marked not available`}.
            {data.status_changed_at &&
              data.status_changed_by?.includes('@') &&
              ` Switched to ${STATUS[data.status].label} on ${when(data.status_changed_at)} by ${data.status_changed_by}.`}
          </p>
          <div class="segmented segmented--inline" role="group" aria-label="Who sees the menu">
            {(['off', 'preview', 'live'] as const).map(s => (
              <button key={s} type="button" aria-pressed={data.status === s} disabled={busy} onClick={() => switchTo(s)}>
                {STATUS[s].label}
              </button>
            ))}
          </div>
          <p class="meta">
            <strong>Off:</strong> not in the app. <strong>Preview:</strong> shown, marked as still being checked. <strong>Live:</strong> shown as the café’s
            menu.
          </p>
          <SheetState sheet={data.sheet} />
          <p>
            <a href="/menu" target="_blank" rel="noopener" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              Open the Food &amp; Drinks page <ExternalLink size={14} aria-hidden="true" />
            </a>
          </p>
          <details>
            <summary>Check every line against the board</summary>
            {data.categories.map(c => (
              <div key={c.id} class="stack" style={{ '--gap': '6px', marginTop: '16px' }}>
                <h3>
                  {c.name} {!c.visible && <Chip kind="draft">Hidden</Chip>}
                </h3>
                <div class="table-wrap">
                  <table class="table menu-check">
                    <thead>
                      <tr>
                        <th scope="col">In the app</th>
                        <th scope="col">Price</th>
                        <th scope="col">Menu wording</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.items.map(i => (
                        <tr key={i.id}>
                          <td>
                            {i.name}
                            {i.options && <span class="meta"> ({i.options})</span>}
                            {!i.shown && ' · hidden'}
                            {!i.available && ' · not available'}
                          </td>
                          <td>{priceText(i)}</td>
                          <td class="meta">{i.source_text}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </details>
        </div>
      )}
    </section>
  );
}

/** Where the menu comes from, when it last changed, and anything wrong with the latest copy. */
function SheetState({ sheet }: { sheet: AdminMenu['sheet'] }) {
  return (
    <div class="stack" style={{ '--gap': '6px' }}>
      <p class="meta">
        Prices, items and what’s available are changed in the <strong>RTD Food Menu</strong> Google Sheet. The app copies it every 15 minutes.
        {sheet.changed_at ? ` The menu last changed on ${when(sheet.changed_at)}.` : ' No copy has arrived yet, so the menu is empty.'}
        {sheet.checked_at && sheet.ok && ` Last checked ${when(sheet.checked_at)}.`}
      </p>
      {sheet.ok === false && (
        <div class="card card--pad" role="alert">
          <p>
            <strong>The latest copy of the sheet ({sheet.checked_at && when(sheet.checked_at)}) wasn’t used.</strong> The app is keeping the menu it had.
            Fix these rows in the sheet:
          </p>
          <ul>
            {sheet.errors.map(e => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {sheet.url && (
        <p>
          <a href={sheet.url} target="_blank" rel="noopener" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            Edit the menu in Google Sheets <ExternalLink size={14} aria-hidden="true" />
          </a>
        </p>
      )}
    </div>
  );
}
