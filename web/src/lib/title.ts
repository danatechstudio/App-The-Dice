import { useEffect } from 'preact/hooks';

export function useTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · Roll The Dice` : 'Roll The Dice · Board Game Café';
  }, [title]);
}
