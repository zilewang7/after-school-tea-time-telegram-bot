/**
 * Code seed of the model capability metadata (thinking-effort design
 * 2026-1113-1742 §1.5, appendix A): the 16 in-use/reference ids as checked on
 * 2026-11-13 against models.dev and the official docs.
 *
 * The 13 menu ids seed `model_catalog` rows on a fresh database; the two image
 * ids and `gemini-3.8-flash` have no row yet, but the traits resolver answers
 * for them by id. The watcher may propose changes to the fields upstream
 * asserts; `toolsMixing`/`nativeTools` are local knowledge and never proposed.
 * `reasoning.defaultEffort` is the vendor default (display/clamp base only).
 */
import type {
    ModelApiName,
    ModelCatalogApiCapabilities,
    ModelCatalogApis,
    ModelCatalogCapabilities,
    ModelCatalogKind,
    ModelCatalogModalities,
    ModelCatalogNativeTools,
    ModelCatalogReasoning,
    ModelCapabilitySource,
    ModelCatalogConfidence,
    ModelEffort,
    ModelToolsMixing,
} from './model-capabilities.js';

const PROVENANCE = {
    source: 'code',
    checkedOn: '2026-11-13',
    confidence: 'high',
} satisfies {
    readonly source: ModelCapabilitySource;
    readonly checkedOn: string;
    readonly confidence: ModelCatalogConfidence;
};

const TEXT_IMAGE_PDF: ModelCatalogModalities = { input: ['text', 'image', 'pdf'], output: ['text'] };
const GEMINI_MODALITIES: ModelCatalogModalities = {
    input: ['text', 'image', 'audio', 'video', 'pdf'],
    output: ['text'],
};
const NANO_BANANA_MODALITIES: ModelCatalogModalities = {
    input: ['text', 'image', 'video', 'pdf'],
    output: ['text', 'image'],
};
const DEEPSEEK_MODALITIES: ModelCatalogModalities = { input: ['text', 'image'], output: ['text'] };
const MIMO_MODALITIES: ModelCatalogModalities = {
    input: ['text', 'image', 'audio', 'video'],
    output: ['text'],
};

const EFFORTS_NONE_TO_MAX: readonly ModelEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORTS_LOW_TO_MAX: readonly ModelEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORTS_GEMINI4: readonly ModelEffort[] = ['low', 'medium', 'high', 'xhigh'];
const EFFORTS_GEMINI_MEDIUM: readonly ModelEffort[] = ['low', 'medium', 'high'];
const EFFORTS_NANO_BANANA: readonly ModelEffort[] = ['minimal', 'medium', 'high'];
const EFFORTS_DEEPSEEK: readonly ModelEffort[] = ['low', 'high', 'max'];
const EFFORTS_GROK: readonly ModelEffort[] = ['low', 'medium', 'high', 'xhigh'];

const OPENAI_APIS: readonly ModelApiName[] = ['responses', 'chat-completions'];
const ANTHROPIC_APIS: readonly ModelApiName[] = ['messages', 'chat-completions'];
const GEMINI_APIS: readonly ModelApiName[] = ['generate-content'];
const DEEPSEEK_APIS: readonly ModelApiName[] = ['chat-completions', 'messages'];
const GROK_APIS: readonly ModelApiName[] = ['responses', 'chat-completions'];
const GROK_MULTI_AGENT_APIS: readonly ModelApiName[] = ['responses'];
const MIMO_APIS: readonly ModelApiName[] = ['chat-completions', 'responses', 'messages'];

interface ReasoningSeed {
    readonly efforts: readonly ModelEffort[];
    /** Vendor default effort; null = no graded default (toggle-only model) */
    readonly defaultEffort: ModelEffort | null;
    readonly toggle?: boolean;
    readonly defaultEnabled?: boolean | null;
}

const reasoningOf = (seed: ReasoningSeed): ModelCatalogReasoning => ({
    ...PROVENANCE,
    supported: true,
    toggle: seed.toggle ?? false,
    efforts: seed.efforts,
    defaultEffort: seed.defaultEffort,
    defaultEnabled: seed.defaultEnabled ?? null,
});

type MutableApis = { -readonly [Key in ModelApiName]?: ModelCatalogApiCapabilities };

/** The per-API subset models.dev provider TOMLs describe: the API exists, its flags follow the model */
const apisOf = (
    names: readonly ModelApiName[],
    options: { readonly tools?: boolean; readonly structuredOutput?: boolean } = {}
): ModelCatalogApis => {
    const flags: ModelCatalogApiCapabilities = {
        reasoning: true,
        tools: options.tools ?? true,
        structuredOutput: options.structuredOutput ?? true,
    };
    const apis: MutableApis = {};
    for (const name of names) apis[name] = flags;
    return apis;
};

interface CapabilitySeed {
    readonly kind: ModelCatalogKind;
    readonly vision: boolean;
    readonly imageOutput?: boolean;
    readonly tools: boolean;
    readonly contextTokens: number | null;
    readonly outputTokens: number | null;
    readonly modalities?: ModelCatalogModalities;
    readonly reasoningSeed?: ReasoningSeed;
    readonly apis?: ModelCatalogApis;
    readonly toolsMixing?: ModelToolsMixing;
    readonly nativeTools?: ModelCatalogNativeTools;
}

const capabilityOf = (seed: CapabilitySeed): ModelCatalogCapabilities => ({
    ...PROVENANCE,
    schema: 1,
    kind: seed.kind,
    vision: seed.vision,
    imageOutput: seed.imageOutput ?? false,
    tools: seed.tools,
    reasoningEffort: seed.reasoningSeed?.efforts ?? [],
    contextTokens: seed.contextTokens,
    outputTokens: seed.outputTokens,
    ...(seed.modalities === undefined ? {} : { modalities: seed.modalities }),
    ...(seed.reasoningSeed === undefined ? {} : { reasoning: reasoningOf(seed.reasoningSeed) }),
    ...(seed.apis === undefined ? {} : { apis: seed.apis }),
    ...(seed.toolsMixing === undefined ? {} : { toolsMixing: seed.toolsMixing }),
    ...(seed.nativeTools === undefined ? {} : { nativeTools: seed.nativeTools }),
});

const MODEL_CAPABILITY_SEEDS: Readonly<Record<string, ModelCatalogCapabilities>> = {
    'gpt-6-luna': capabilityOf({
        kind: 'chat',
        vision: true,
        tools: true,
        contextTokens: 1_050_000,
        outputTokens: 128_000,
        modalities: TEXT_IMAGE_PDF,
        reasoningSeed: { efforts: EFFORTS_NONE_TO_MAX, defaultEffort: 'medium' },
        apis: apisOf(OPENAI_APIS),
    }),
    'gpt-6-sol': capabilityOf({
        kind: 'chat',
        vision: true,
        tools: true,
        contextTokens: 1_050_000,
        outputTokens: 128_000,
        modalities: TEXT_IMAGE_PDF,
        reasoningSeed: { efforts: EFFORTS_NONE_TO_MAX, defaultEffort: 'medium' },
        apis: apisOf(OPENAI_APIS),
    }),
    'gpt-6-astra': capabilityOf({
        kind: 'chat',
        vision: true,
        tools: true,
        contextTokens: 1_050_000,
        outputTokens: 128_000,
        modalities: TEXT_IMAGE_PDF,
        reasoningSeed: { efforts: EFFORTS_LOW_TO_MAX, defaultEffort: 'medium' },
        apis: apisOf(OPENAI_APIS),
    }),
    'claude-sonnet-5-5': capabilityOf({
        kind: 'chat',
        vision: true,
        tools: true,
        contextTokens: 1_000_000,
        outputTokens: 128_000,
        modalities: TEXT_IMAGE_PDF,
        reasoningSeed: { efforts: EFFORTS_LOW_TO_MAX, defaultEffort: 'high' },
        apis: apisOf(ANTHROPIC_APIS),
    }),
    'claude-opus-5-5': capabilityOf({
        kind: 'chat',
        vision: true,
        tools: true,
        contextTokens: 1_000_000,
        outputTokens: 128_000,
        modalities: TEXT_IMAGE_PDF,
        reasoningSeed: { efforts: EFFORTS_LOW_TO_MAX, defaultEffort: 'high' },
        apis: apisOf(ANTHROPIC_APIS),
    }),
    'gemini-4-hydrogen': capabilityOf({
        kind: 'chat',
        vision: true,
        tools: true,
        contextTokens: 1_048_576,
        outputTokens: 65_536,
        modalities: GEMINI_MODALITIES,
        reasoningSeed: { efforts: EFFORTS_GEMINI4, defaultEffort: 'high' },
        apis: apisOf(GEMINI_APIS),
        toolsMixing: 'allowed',
    }),
    'gemini-4-argon': capabilityOf({
        kind: 'chat',
        vision: true,
        tools: true,
        contextTokens: 1_048_576,
        outputTokens: 65_536,
        modalities: GEMINI_MODALITIES,
        reasoningSeed: { efforts: EFFORTS_GEMINI_MEDIUM, defaultEffort: 'medium' },
        apis: apisOf(GEMINI_APIS),
        toolsMixing: 'allowed',
    }),
    'gemini-4-carbon': capabilityOf({
        kind: 'chat',
        vision: true,
        tools: true,
        contextTokens: 1_048_576,
        outputTokens: 65_536,
        modalities: GEMINI_MODALITIES,
        reasoningSeed: { efforts: EFFORTS_GEMINI_MEDIUM, defaultEffort: 'medium' },
        apis: apisOf(GEMINI_APIS),
        toolsMixing: 'allowed',
    }),
    'gemini-3.8-flash': capabilityOf({
        kind: 'chat',
        vision: true,
        tools: true,
        contextTokens: 1_048_576,
        outputTokens: 65_536,
        modalities: GEMINI_MODALITIES,
        reasoningSeed: { efforts: EFFORTS_GEMINI_MEDIUM, defaultEffort: 'medium' },
        apis: apisOf(GEMINI_APIS),
        toolsMixing: 'allowed',
    }),
    'gemini-nano-banana-2.1': capabilityOf({
        kind: 'image',
        vision: true,
        imageOutput: true,
        tools: false,
        contextTokens: 131_072,
        outputTokens: 32_768,
        modalities: NANO_BANANA_MODALITIES,
        reasoningSeed: { efforts: EFFORTS_NANO_BANANA, defaultEffort: 'medium' },
        apis: apisOf(GEMINI_APIS, { tools: false, structuredOutput: false }),
        nativeTools: { imageSearchGrounding: true },
    }),
    'deepseek-flash': capabilityOf({
        kind: 'chat',
        vision: true,
        tools: true,
        contextTokens: 1_048_576,
        outputTokens: 393_216,
        modalities: DEEPSEEK_MODALITIES,
        reasoningSeed: {
            efforts: EFFORTS_DEEPSEEK,
            defaultEffort: 'high',
            toggle: true,
            defaultEnabled: true,
        },
        apis: apisOf(DEEPSEEK_APIS),
    }),
    'grok-4.7': capabilityOf({
        kind: 'chat',
        vision: true,
        tools: true,
        // Canonical lab document: context and output are both 500,000
        contextTokens: 500_000,
        outputTokens: 500_000,
        modalities: TEXT_IMAGE_PDF,
        reasoningSeed: { efforts: EFFORTS_GROK, defaultEffort: 'high' },
        apis: apisOf(GROK_APIS),
    }),
    'grok-4.20-multi-agent-0309': capabilityOf({
        kind: 'chat',
        vision: true,
        tools: false,
        contextTokens: 1_000_000,
        outputTokens: 30_000,
        modalities: TEXT_IMAGE_PDF,
        reasoningSeed: { efforts: EFFORTS_GROK, defaultEffort: 'high' },
        apis: apisOf(GROK_MULTI_AGENT_APIS, { tools: false }),
    }),
    'mimo-v2.6-flash': capabilityOf({
        kind: 'chat',
        vision: true,
        tools: true,
        contextTokens: 1_048_576,
        outputTokens: 131_072,
        modalities: MIMO_MODALITIES,
        reasoningSeed: { efforts: [], defaultEffort: null, toggle: true, defaultEnabled: true },
        apis: apisOf(MIMO_APIS),
    }),
    'mimo-v2.6-pro': capabilityOf({
        kind: 'chat',
        vision: true,
        tools: true,
        contextTokens: 1_048_576,
        outputTokens: 131_072,
        modalities: MIMO_MODALITIES,
        reasoningSeed: { efforts: [], defaultEffort: null, toggle: true, defaultEnabled: true },
        apis: apisOf(MIMO_APIS),
    }),
    // Relay-only image id: no models.dev page, so only the local facts are known
    'gpt-image-2.5-dev': capabilityOf({
        kind: 'image',
        vision: false,
        imageOutput: true,
        tools: false,
        contextTokens: null,
        outputTokens: null,
    }),
};

/** The ids the seed covers (13 menu + 2 image + gemini-3.8-flash) */
export const capabilitySeedIds = (): readonly string[] => Object.keys(MODEL_CAPABILITY_SEEDS);

/** The code seed of one model, null when the snapshot does not cover it */
export const capabilitySeedOf = (modelId: string): ModelCatalogCapabilities | null => {
    const id = modelId.toLowerCase();
    if (!Object.hasOwn(MODEL_CAPABILITY_SEEDS, id)) return null;
    return MODEL_CAPABILITY_SEEDS[id] ?? null;
};
