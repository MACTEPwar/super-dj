import { useEffect } from 'react';

// Every route rendered the same static "super-dj" tab title otherwise, making it impossible to
// tell pages apart across multiple open tabs. Restores the previous title on unmount so a drawer
// or modal open over a page (which doesn't call this itself) never leaves a stale title behind.
export function usePageTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} — super-dj`;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
