/** Capture the reporting channel even when another listener already claims its events. */
export function captureErrorReports(): {
  reports: unknown[];
  release: () => void;
} {
  const reports: unknown[] = [];
  const listener = (event: Event): void => {
    reports.push((event as ErrorEvent).error);
    event.preventDefault();
  };
  globalThis.addEventListener('error', listener);
  return {
    reports,
    release: () => {
      globalThis.removeEventListener('error', listener);
    },
  };
}
