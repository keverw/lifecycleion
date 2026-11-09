/**
 * Whether a parsed URL's `hostname` names this machine, as browsers treat it as
 * potentially trustworthy: `localhost` and any name under it (a trailing dot aside),
 * `[::1]`, and an IPv4 address in `127.0.0.0/8`.
 */
export function isLoopbackHost(hostname: string): boolean {
  const name = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;

  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}
