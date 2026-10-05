import { EmptyState } from '../components/States';
import { useTitle } from '../lib/title';

export function NotFound() {
  useTitle('Not found');
  return (
    <div class="container">
      <EmptyState title="This page rolled under the table." text="The link may be old, or mistyped.">
        <div class="cluster" style={{ justifyContent: 'center' }}>
          <a class="btn btn--primary" href="/">Back to RTD</a>
          <a class="btn btn--secondary" href="/diary">See what's on</a>
        </div>
      </EmptyState>
    </div>
  );
}
