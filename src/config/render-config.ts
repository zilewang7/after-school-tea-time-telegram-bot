/**
 * Display switches, read from the env once (on first use).
 *
 * - GROUNDING_CITATIONS=0: no superscript source markers in the reply text;
 *   the GoogleSearch footer keeps its sources
 */
export interface RenderConfig {
    readonly groundingCitations: boolean;
}

/** The settings in `env`; exported for tests, the app goes through getRenderConfig */
export const readRenderConfig = (env: NodeJS.ProcessEnv = process.env): RenderConfig => ({
    groundingCitations: env.GROUNDING_CITATIONS !== '0',
});

let cachedRenderConfig: RenderConfig | undefined;

export const getRenderConfig = (): RenderConfig => {
    cachedRenderConfig ??= readRenderConfig();
    return cachedRenderConfig;
};
