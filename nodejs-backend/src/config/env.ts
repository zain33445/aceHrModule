import 'dotenv/config';

const warned = new Set<string>();

/**
 * Returns a configured secret, or a clearly-labelled development fallback.
 * Production refuses to start rather than silently using an insecure key.
 */
export function resolveSecret(name: string, devFallback: string): string {
  const configured = process.env[name]?.trim();
  if (configured) return configured;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `${name} must be set in production — refusing to start with an insecure fallback.`
    );
  }

  if (!warned.has(name)) {
    warned.add(name);
    console.warn(
      `[config] ${name} is not set — using a labelled development-only fallback. Set it before deploying.`
    );
  }

  return devFallback;
}
