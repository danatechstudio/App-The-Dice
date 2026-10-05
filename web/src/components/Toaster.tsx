import { useToasts } from '../lib/toast';

export function Toaster() {
  const toasts = useToasts();
  return (
    <div class="toaster" role="status" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} class="toast">
          {t.text}
        </div>
      ))}
    </div>
  );
}
