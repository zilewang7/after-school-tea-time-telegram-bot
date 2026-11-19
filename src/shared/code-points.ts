/**
 * Length checks in this repository count code points, not UTF-16 units, so a
 * character outside the basic plane (an emoji, a rare CJK glyph) counts as one
 * wherever a user would say "one character".
 */
export const countCodePoints = (text: string): number => Array.from(text).length;
