/**
 * Turn a parsed pic command plus whatever reference images the message carries
 * into a comfy-forward request — including the decision of WHICH workflow runs.
 *
 * Pure: it takes the workflow list as an argument instead of fetching it, so
 * the selection rules are testable without a server.
 */
import type { ComfyWorkflow, GenerationRequest } from '../../services/comfy-forward-service.js';
import { MAX_INPUT_IMAGE_BYTES } from '../../services/comfy-forward-service.js';
import type { PicCommandSpec } from './pic-command-parser.js';

/** The API's documented cap */
const MAX_PROMPT_LENGTH = 10_000;

export interface BuildInput {
    spec: PicCommandSpec;
    workflows: ComfyWorkflow[];
    /** Base64 images found on the reply target and the command message */
    referenceImages: string[];
}

export type BuildResult =
    | {
        ok: true;
        request: GenerationRequest;
        workflow: ComfyWorkflow;
        /** More than one image was available but only the first is sent */
        extraReferenceImages: number;
    }
    | { ok: false; reason: string };

type WorkflowChoice =
    | { ok: true; workflow: ComfyWorkflow }
    | { ok: false; reason: string };

/**
 * Explicit `-w=` wins; otherwise the presence of a reference image decides,
 * which is the whole point of having one command instead of two.
 */
const pickWorkflow = (
    workflows: ComfyWorkflow[],
    query: string | null,
    hasReference: boolean
): WorkflowChoice => {
    const known = (): string => workflows.map((workflow) => `\`${workflow.id}\``).join('、');

    if (query) {
        const lowered = query.toLowerCase();
        const exact = workflows.find((workflow) => workflow.id.toLowerCase() === lowered);
        if (exact) return { ok: true, workflow: exact };

        const prefixed = workflows.filter((workflow) =>
            workflow.id.toLowerCase().startsWith(lowered)
        );
        if (prefixed.length === 1) return { ok: true, workflow: prefixed[0]! };
        if (prefixed.length > 1) {
            return {
                ok: false,
                reason: `\`-w=${query}\` 能对上好几个工作流：${prefixed.map((w) => `\`${w.id}\``).join('、')}`,
            };
        }
        return { ok: false, reason: `没有叫 \`${query}\` 的工作流。现在有：${known()}` };
    }

    const wanted = hasReference ? 'image-edit' : 'text-to-image';
    const chosen = workflows.find((workflow) => workflow.kind === wanted);
    if (chosen) return { ok: true, workflow: chosen };

    return {
        ok: false,
        reason: hasReference
            ? `服务端没有可用的图生图工作流。现在有：${known()}`
            : `服务端没有可用的文生图工作流。现在有：${known()}`,
    };
};

/**
 * A seed is always sent, even when the user didn't pick one: it is what makes
 * the caption reproducible and gives 🎲 重掷 something to change.
 */
const randomSeed = (): number => Math.floor(Math.random() * 2 ** 31);

const decodedSizeOf = (base64: string): number => Math.floor((base64.length * 3) / 4);

export const buildGenerationRequest = (input: BuildInput): BuildResult => {
    const { spec, workflows, referenceImages } = input;

    if (!spec.prompt) {
        return { ok: false, reason: '请给出提示词' };
    }
    if (spec.prompt.length > MAX_PROMPT_LENGTH) {
        return { ok: false, reason: `提示词太长了（${spec.prompt.length} 字，上限 ${MAX_PROMPT_LENGTH}）` };
    }

    const choice = pickWorkflow(workflows, spec.workflowQuery, referenceImages.length > 0);
    if (!choice.ok) return { ok: false, reason: choice.reason };
    const { workflow } = choice;

    const reference = referenceImages[0];
    if (workflow.input_image_required && !reference) {
        return {
            ok: false,
            reason: `\`${workflow.id}\` 是图生图工作流，需要一张参考图：回复一张图片，或者发图片时把命令写在图片说明里`,
        };
    }
    if (reference && decodedSizeOf(reference) > MAX_INPUT_IMAGE_BYTES) {
        return { ok: false, reason: '参考图太大了（超过 20 MiB），换一张小一点的' };
    }

    const request: GenerationRequest = {
        workflow: workflow.id,
        prompt: spec.prompt,
        options: { seed: randomSeed(), ...spec.options },
    };

    // An image-edit workflow needs the reference; a text-to-image one ignores it
    if (reference && workflow.input_image_required) {
        request.input_image = { data: reference, filename: 'reference.png' };
    }

    if (spec.negativePrompt) {
        request.negative_prompt = spec.negativePrompt;
        if (spec.negativePromptOverride) request.negative_prompt_override = true;
    }

    return {
        ok: true,
        request,
        workflow,
        extraReferenceImages:
            request.input_image === undefined ? 0 : Math.max(0, referenceImages.length - 1),
    };
};
