/**
 * Two pure steps between a parsed `/vid` and a comfy-forward request.
 *
 * `planVideoGeneration` decides WHAT is being made — which workflow runs it and
 * which H3 conditioning mode the storyboard has to be written for. That has to
 * happen before Grok is called, because the mode picks the output format.
 * `buildVideoRequest` then wraps the finished storyboard into the request body,
 * attaching the images to whichever fields the chosen workflow accepts.
 *
 * The two axes are independent (API 2.3.0, "MiniMax H3 模式"): I2V / Ref2VA is
 * the conditioning, Turbo / Base is the sampling scheme. `-mode=` picks the
 * first, `-w=` picks the second — and each is inferred from the other when only
 * one is given.
 *
 * Both take the workflow list as an argument instead of fetching it, so the
 * rules are testable without a server.
 */
import {
    MAX_INPUT_IMAGE_BYTES,
    mediaKindOfWorkflow,
    workflowAccepts,
    type ComfyWorkflow,
    type GenerationOptionValue,
    type GenerationRequest,
    type MediaPayload,
} from '../../services/comfy-forward-service.js';
import type { VidCommandSpec, VidMode } from './vid-command-parser.js';
import { describeWorkflows, matchWorkflowByQuery } from './workflow-picker.js';

/** The API's documented cap */
const MAX_PROMPT_LENGTH = 10_000;

const DEFAULT_DURATION_SECONDS = 5;
const DEFAULT_ASPECT_RATIO = '16:9';

/** `reference_images` takes 1-9; frame anchoring takes a first and a last */
const MAX_REFERENCE_IMAGES = 9;
const MAX_FRAME_IMAGES = 2;

/** `auto` is gone by the time anything downstream sees a plan */
export type ResolvedVidMode = Exclude<VidMode, 'auto'>;

/** The frame-anchored modes, which use `first_frame`/`last_frame` */
const isFrameAnchored = (mode: ResolvedVidMode): boolean => mode === 'i2va' || mode === 'fl2va';

export interface VideoPlan {
    workflow: ComfyWorkflow;
    mode: ResolvedVidMode;
    /** What the storyboard has to fit into, and what the API is told */
    durationSeconds: number;
    aspectRatio: string;
    /** False when the ratio should be left out so I2V follows the first frame */
    sendAspectRatio: boolean;
    shots: number | null;
    /** The images actually sent, in order */
    referenceImages: string[];
    /** Images the message carried that won't be used */
    extraReferenceImages: number;
}

export type VideoPlanResult =
    | { ok: true; plan: VideoPlan }
    | { ok: false; reason: string };

export interface VideoPlanInput {
    spec: VidCommandSpec;
    workflows: ComfyWorkflow[];
    /** Base64 images found on the reply target and the command message */
    referenceImages: string[];
}

const videoWorkflowsOf = (workflows: ComfyWorkflow[]): ComfyWorkflow[] =>
    workflows.filter((workflow) => mediaKindOfWorkflow(workflow.kind) === 'video');

/**
 * Turbo is the 6-step LoRA; Base is the 24-step `res_multistep` baseline. The
 * declared LoRA strength is the honest signal — it only exists on Turbo — with
 * the id as a fallback for a server that stops declaring defaults.
 */
const isTurboSampling = (workflow: ComfyWorkflow): boolean =>
    workflow.default_options?.lora_strength !== undefined ||
    !workflow.id.toLowerCase().includes('base');

/**
 * Without `-w=`, pick by what the request needs. Turbo first: a video command
 * that quietly chose the 24-step quality workflow would take four times as long
 * for no reason the user asked for. Quality mode is `-w=base`.
 */
const pickVideoWorkflow = (
    workflows: ComfyWorkflow[],
    spec: VidCommandSpec,
    imageCount: number
): { ok: true; workflow: ComfyWorkflow } | { ok: false; reason: string } => {
    if (spec.workflowQuery) {
        const matched = matchWorkflowByQuery(workflows, spec.workflowQuery);
        if (!matched.ok) return matched;
        if (mediaKindOfWorkflow(matched.workflow.kind) !== 'video') {
            return {
                ok: false,
                reason: `\`${matched.workflow.id}\` 是出图的工作流，出图请用 /pic`,
            };
        }
        return { ok: true, workflow: matched.workflow };
    }

    const candidates = videoWorkflowsOf(workflows);
    if (candidates.length === 0) {
        return {
            ok: false,
            reason: `服务端没有可用的文生视频工作流。现在有：${describeWorkflows(workflows)}`,
        };
    }

    const turboFirst = [
        ...candidates.filter(isTurboSampling),
        ...candidates.filter((workflow) => !isTurboSampling(workflow)),
    ];

    // An explicit frame-anchoring mode needs a workflow that anchors frames
    if (spec.mode === 'i2va' || spec.mode === 'fl2va') {
        const anchoring = turboFirst.find((workflow) => workflowAccepts(workflow, 'first_frame'));
        if (!anchoring) {
            return {
                ok: false,
                reason: `服务端没有支持首帧的工作流。现在有：${describeWorkflows(candidates)}`,
            };
        }
        return { ok: true, workflow: anchoring };
    }

    // More images than a single `input_image` can carry needs a Ref2VA workflow
    if (imageCount > 1) {
        const multi = turboFirst.find((workflow) => workflowAccepts(workflow, 'reference_images'));
        if (multi) return { ok: true, workflow: multi };
    }

    // Otherwise the plain one: T2V, or single-image Ref2VA
    const plain = turboFirst.find(
        (workflow) => !workflow.input_image_required && workflowAccepts(workflow, 'input_image')
    );
    return { ok: true, workflow: plain ?? turboFirst[0]! };
};

/**
 * Which H3 conditioning the storyboard is written for.
 *
 * On the Turbo and Ref2V workflows an image goes through
 * MiniMaxH3ReferenceToVideo — it constrains identity, appearance and scene
 * rather than pinning a frame, so `ref2va` is the honest format. Only a
 * workflow that accepts `first_frame` is actually anchoring frames.
 */
export const resolveVidMode = (
    requested: VidMode,
    workflow: ComfyWorkflow,
    imageCount: number
): ResolvedVidMode => {
    if (requested !== 'auto') return requested;
    if (imageCount === 0) return 't2va';

    // `minimax-h3-base` accepts both; with no explicit -mode= the reference
    // reading is the safer one — it never locks a frame the user didn't ask to lock
    if (workflowAccepts(workflow, 'first_frame') && !workflowAccepts(workflow, 'reference_images')) {
        return imageCount >= 2 ? 'fl2va' : 'i2va';
    }
    return 'ref2va';
};

const numberOption = (
    options: Record<string, GenerationOptionValue>,
    key: string,
    fallback: number
): number => {
    const value = options[key];
    return typeof value === 'number' ? value : fallback;
};

const stringOption = (
    options: Record<string, GenerationOptionValue>,
    key: string,
    fallback: string
): string => {
    const value = options[key];
    return typeof value === 'string' ? value : fallback;
};

const decodedSizeOf = (base64: string): number => Math.floor((base64.length * 3) / 4);

/** How many of the message's images this workflow and mode can actually use */
const imageCapacityOf = (workflow: ComfyWorkflow, mode: ResolvedVidMode): number => {
    // i2va is first-frame only by definition — a second image would silently
    // become a last frame the user never asked to lock
    if (mode === 'i2va') return 1;
    if (mode === 'fl2va') return workflowAccepts(workflow, 'last_frame') ? MAX_FRAME_IMAGES : 1;
    if (workflowAccepts(workflow, 'reference_images')) return MAX_REFERENCE_IMAGES;
    return workflowAccepts(workflow, 'input_image') ? 1 : 0;
};

export const planVideoGeneration = (input: VideoPlanInput): VideoPlanResult => {
    const { spec, workflows, referenceImages } = input;

    if (!spec.brief) return { ok: false, reason: '请说一下想要什么样的视频' };
    if (spec.brief.length > MAX_PROMPT_LENGTH) {
        return { ok: false, reason: `想法太长了（${spec.brief.length} 字，上限 ${MAX_PROMPT_LENGTH}）` };
    }

    const choice = pickVideoWorkflow(workflows, spec, referenceImages.length);
    if (!choice.ok) return { ok: false, reason: choice.reason };
    const { workflow } = choice;

    // Turbo's LoRA is trained for 4-8 steps and the server rejects anything
    // else; catching it here saves a round trip. Base runs 1-100, so it is left
    // to the server, which knows its real range.
    const steps = spec.options.steps;
    if (isTurboSampling(workflow) && typeof steps === 'number' && (steps < 4 || steps > 8)) {
        return { ok: false, reason: `\`${workflow.id}\` 的 \`-steps=\` 只能是 4-8（Turbo LoRA 的范围）` };
    }

    const mode = resolveVidMode(spec.mode, workflow, referenceImages.length);
    if (isFrameAnchored(mode) && !workflowAccepts(workflow, 'first_frame')) {
        return {
            ok: false,
            reason: `\`${workflow.id}\` 不支持首帧锁定，换 \`-mode=ref2va\` 或者别指定 \`-w=\``,
        };
    }

    const usable = referenceImages.slice(0, imageCapacityOf(workflow, mode));
    if (isFrameAnchored(mode) && usable.length === 0) {
        return { ok: false, reason: `\`-mode=${mode}\` 需要一张作为首帧的图片` };
    }
    if (mode === 'fl2va' && usable.length < MAX_FRAME_IMAGES) {
        // Grok would otherwise write an instruction line about a <Picture 2>
        // that was never uploaded
        return { ok: false, reason: '`-mode=fl2va` 需要两张图：第一张锁首帧，第二张锁尾帧' };
    }
    if (workflow.input_image_required && usable.length === 0) {
        return {
            ok: false,
            reason: `\`${workflow.id}\` 需要一张参考图：回复一张图片，或者发图片时把命令写在图片说明里`,
        };
    }

    const oversized = usable.find((image) => decodedSizeOf(image) > MAX_INPUT_IMAGE_BYTES);
    if (oversized) return { ok: false, reason: '参考图太大了（超过 20 MiB），换一张小一点的' };

    // I2V follows the first frame's aspect ratio when none is given, which is
    // almost always what someone anchoring a frame wants
    const explicitRatio = spec.options.aspect_ratio !== undefined;
    const explicitSize = spec.options.width !== undefined && spec.options.height !== undefined;

    return {
        ok: true,
        plan: {
            workflow,
            mode,
            durationSeconds: numberOption(spec.options, 'duration_seconds', DEFAULT_DURATION_SECONDS),
            aspectRatio: stringOption(spec.options, 'aspect_ratio', DEFAULT_ASPECT_RATIO),
            sendAspectRatio: !explicitSize && (explicitRatio || !isFrameAnchored(mode)),
            shots: spec.shots,
            referenceImages: usable,
            extraReferenceImages: Math.max(0, referenceImages.length - usable.length),
        },
    };
};

/**
 * A seed is always sent, even when the user didn't pick one: it is what makes
 * the caption reproducible and gives 🎲 重掷 something to change.
 */
const randomSeed = (): number => Math.floor(Math.random() * 2 ** 31);

const payload = (data: string, name: string): MediaPayload => ({ data, filename: name });

/** Put each image on the field the chosen workflow reads it from */
const attachImages = (request: GenerationRequest, plan: VideoPlan): void => {
    const [first, ...rest] = plan.referenceImages;
    if (!first) return;

    if (isFrameAnchored(plan.mode)) {
        request.first_frame = payload(first, 'first-frame.png');
        const last = rest[0];
        if (last) request.last_frame = payload(last, 'last-frame.png');
        return;
    }

    // Ref2VA: one image can ride on the legacy single field, which the Turbo
    // workflow is the only one to accept
    if (rest.length === 0 && !workflowAccepts(plan.workflow, 'reference_images')) {
        request.input_image = payload(first, 'reference.png');
        return;
    }

    request.reference_images = plan.referenceImages.map((image, index) =>
        payload(image, `reference-${index + 1}.png`)
    );
};

/**
 * Wrap a finished storyboard into the request body. The duration the plan
 * settled on is sent explicitly even when it is the server's own default — the
 * storyboard was written to fit it, so leaving it implicit would let a
 * server-side default change silently desynchronise the two.
 */
export const buildVideoRequest = (
    plan: VideoPlan,
    spec: VidCommandSpec,
    prompt: string
): GenerationRequest => {
    const options: Record<string, GenerationOptionValue> = {
        seed: randomSeed(),
        ...spec.options,
        duration_seconds: plan.durationSeconds,
    };

    if (plan.sendAspectRatio) {
        options.aspect_ratio = plan.aspectRatio;
    } else {
        // An explicit -size= makes it meaningless, and on I2V its absence is
        // what makes the output follow the first frame
        delete options.aspect_ratio;
    }

    const request: GenerationRequest = {
        workflow: plan.workflow.id,
        prompt: prompt.slice(0, MAX_PROMPT_LENGTH),
        options,
    };

    attachImages(request, plan);

    return request;
};
