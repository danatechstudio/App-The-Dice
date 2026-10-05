import { useEffect, useState } from 'preact/hooks';

type Toast = { id: number; text: string };
let toasts: Toast[] = [];
let next = 1;
const listeners = new Set<(t: Toast[]) => void>();

export function toast(text: string): void {
  const t = { id: next++, text };
  toasts = [...toasts, t];
  listeners.forEach(l => l(toasts));
  setTimeout(() => {
    toasts = toasts.filter(x => x.id !== t.id);
    listeners.forEach(l => l(toasts));
  }, 3200);
}

export function useToasts(): Toast[] {
  const [list, setList] = useState(toasts);
  useEffect(() => {
    listeners.add(setList);
    return () => void listeners.delete(setList);
  }, []);
  return list;
}
