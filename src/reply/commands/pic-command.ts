/**
 * `/pic` and `/picunsafe` — image generation through comfy-forward.
 *
 * One command instead of one-per-model: the workflow follows from whether the
 * message carries a reference image, which the message already tells us. See
 * docs/2026-0807-1701.
 *
 * Routed from chat-handler (not `bot.command()`) so it inherits the wait for
 * in-flight media: when the picture and the command arrive together, the file
 * is still downloading when the update lands, and collecting reference images
 * any earlier would find nothing.
 */
import type { Context } from 'grammy';
import { to } from '../../shared/result.js';
import {
    isComfyConfigured,
    listWorkflows,
    mediaKindOfWorkflow,
} from '../../services/comfy-forward-service.js';
import { collectReferenceImages } from './reference-images.js';
import { parsePicCommand, type PicCommandSpec } from './pic-command-parser.js';
import { buildGenerationRequest } from './pic-request-builder.js';
import { runGeneration } from './generation-runner.js';

const HELP_HEADER = [
    '🎨 生图用法',
    '',
    '`/pic 提示词` — 文生图',
    '回复一张图片再 `/pic 提示词` — 图生图（发图时写在图片说明里也行）',
    '`/picunsafe` 与 `/pic` 完全一样，只是出图不打遮罩',
    '',
    '可选参数写在提示词前面：',
    '`-w=` 工作流　`-seed=` 种子　`-steps=` 步数　`-cfg=`',
    '`-size=1024x1024`　`-n=` 张数(1-8)　`-ar=auto|input|landscape`　`-mp=` 参考图缩放',
    '`-: 负面词`　`-!: 负面词`(不拼接内置负面词，仅 Z-Image)',
    '',
    '例：`/pic -steps=20 -size=1344x768 屋顶上的三花猫 -: 模糊`',
].join('\n');

/** The help ends with what the server currently offers, not a hardcoded list */
const buildHelpText = async (): Promise<string> => {
    const workflows = await listWorkflows();
    // The server also offers video workflows now; those belong to /vid
    const lines = workflows
        .filter((workflow) => mediaKindOfWorkflow(workflow.kind) === 'image')
        .map((workflow) => `· \`${workflow.id}\` — ${workflow.name}`);
    return `${HELP_HEADER}\n\n当前可用工作流：\n${lines.join('\n')}\n\n出视频用 /vid`;
};

const replyWith = async (ctx: Context, text: string): Promise<void> => {
    if (!ctx.message) return;
    await to(
        ctx.reply(text, {
            reply_parameters: { message_id: ctx.message.message_id },
            parse_mode: 'Markdown',
        })
    );
};

/** Whether this message is a pic command at all (chat-handler's routing gate) */
export const checkPicCommand = (ctx: Context): boolean =>
    parsePicCommand(ctx.message?.text ?? ctx.message?.caption).type !== 'none';

const startRun = async (ctx: Context, spec: PicCommandSpec): Promise<void> => {
    if (!ctx.message || !ctx.chat) return;

    const chatId = ctx.chat.id;
    const userMessageId = ctx.message.message_id;

    const referenceImages = await collectReferenceImages(chatId, [
        ctx.message.reply_to_message?.message_id,
        userMessageId,
    ]);

    const built = buildGenerationRequest({
        spec,
        workflows: await listWorkflows(),
        referenceImages,
    });

    if (!built.ok) {
        await replyWith(ctx, built.reason);
        return;
    }

    console.log('[pic] submitting', {
        workflow: built.request.workflow,
        promptLength: built.request.prompt.length,
        hasReference: Boolean(built.request.input_image),
        options: built.request.options,
        spoiler: spec.spoiler,
    });

    if (built.extraReferenceImages > 0) {
        await replyWith(
            ctx,
            `这条消息里有 ${built.extraReferenceImages + 1} 张图，只有第 1 张会作为参考图`
        );
    }

    await runGeneration({
        api: ctx.api,
        chatId,
        userMessageId,
        kind: 'image',
        request: built.request,
        spoiler: spec.spoiler,
        workflowName: built.workflow.name,
    });
};

/**
 * Handle a pic command. Assumes `checkPicCommand` already said yes; never
 * throws (chat-handler runs it detached from grammy's error handling).
 */
export const handlePicCommand = async (ctx: Context): Promise<void> => {
    if (!ctx.message || !ctx.chat) return;

    if (!isComfyConfigured()) {
        await replyWith(ctx, '生成服务未配置');
        return;
    }

    const parsed = parsePicCommand(ctx.message.text ?? ctx.message.caption);
    if (parsed.type === 'none') return;

    // One wrong parameter used to bury the answer under the whole help text
    if (parsed.type === 'invalid') {
        await replyWith(ctx, `${parsed.reason}\n\n完整用法：单独发一条 \`/pic\``);
        return;
    }

    if (!parsed.spec.prompt) {
        await replyWith(ctx, await buildHelpText());
        return;
    }

    const [error] = await to(startRun(ctx, parsed.spec));
    if (error) {
        console.error('[pic] unhandled failure:', error);
        await replyWith(ctx, `生图失败：${error.message}`);
    }
};
