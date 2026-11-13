/**
 * The panel's public origin, read from the env on every call.
 *
 * Lives in the shared layer (not panel/share) so the bot side can build a
 * public URL from any layer without an upward import; offline cases set the
 * env before importing src, and production injects it through compose.
 */
export const webappPublicUrl = (): string => (process.env.WEBAPP_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
