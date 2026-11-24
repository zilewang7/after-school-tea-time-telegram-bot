/**
 * Feature switch for progressive prompt disclosure (conditional format legends).
 *
 * Enabled by default so static heads stay slim; set `PROMPT_FORMAT_LEGEND=0`
 * to roll back to the legacy full static format section.
 */
export const isFormatLegendEnabled = (): boolean => process.env.PROMPT_FORMAT_LEGEND !== '0';
