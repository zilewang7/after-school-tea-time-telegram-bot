/**
 * Guide version snapshot. The guide bodies themselves now live in
 * `skills/widget-a2ui/SKILL.md` and `skills/widget-html/SKILL.md` and are
 * loaded on demand via `load_skill`.
 *
 * v2: split bot roundtrip (`request()`/state, unavailable in Phase 0) from
 * local sandbox interaction (inline script + click, supported by profile 1);
 * the v1 text said both "JS and taps work" and "output zero JS" (issue #6).
 * v3: the A2UI guide's tool-argument example is a valid escaped JSON string
 * (v2 rendered `"` where the model must write `\"`).
 * v4: the HTML guide names the workspace as the cheap way to measure a draft:
 * workspace write/edit report raw and zlib9 bytes after every edit.
 */
export const WIDGET_GUIDE_VERSION = 4;
