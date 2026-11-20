/**
 * Re-export the layer-0 prefix routing so existing `src/ai` callers keep their
 * import path without duplicating the rule.
 */
export { platformTypeOf, type PlatformType } from '../config/platform-routing.js';
