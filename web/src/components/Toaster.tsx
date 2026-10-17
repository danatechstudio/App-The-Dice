import { Dices } from 'lucide-preact';
import { useToasts } from '../lib/toast';

export function Toaster() {
  const toasts = useToasts();
  return (
    <div class="toaster" role="status" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} class="toast">
          <Dices size={20} aria-hidden="true" class="toast__dice" />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
