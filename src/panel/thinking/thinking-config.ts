/**
 * The feature switch of the thinking view (design §10): on unless `THINKING_LINK`
 * is exactly `0`, and only meaningful with a public URL to point the links at.
 *
 * The env is read per call rather than once at import: offline cases set it
 * before invoking, and production injects it through compose.
 */
import { webappPublicUrl } from '../share/share-urls.js';

export const thinkingLinkEnabled = (): boolean =>
    (process.env.THINKING_LINK ?? '').trim() !== '0' && webappPublicUrl() !== '';
