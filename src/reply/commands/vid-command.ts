/**
 * `/vid` and `/vidunsafe` — video generation through comfy-forward's MiniMax H3
 * workflows, with Grok writing the storyboard. See docs/2026-0810-0120.
 *
 * The user gives a rough idea; the H3 prompt format (timed shots, camera
 * motion, soundscape, speaker IDs) is nothing anyone should have to type by
 * hand, so the expansion happens here and is then shown to the user in a
 * collapsed quote — visible enough to learn from and tweak, quiet enough not to
 * flood the chat.
 *
 * Routed from chat-handler for the same reason `/pic` is: a reference image
 * arriving in the same update is still downloading when the update lands.
 */
import type { Api, Context } from 'grammy';
import { to } from '../../shared/result.js';
import {
    isComfyConfigured,
    checkHealth,
    listWorkflows,
    mediaKindOfWorkflow,
} from '../../services/comfy-forward-service.js';
import {
    enhanceVideoPrompt,
    isH3EnhancerConfigured,
    H3PromptError,
} from '../../services/h3-prompt-service.js';
import { collectReferenceImages } from './reference-images.js';
import { parseVidCommand, type VidCommandSpec } from './vid-command-parser.js';
import { buildVideoRequest, planVideoGeneration, type VideoPlan } from './vid-request-builder.js';
import { runGeneration } from './generation-runner.js';
import { rememberAction } from './generation-actions.js';
import { buildRetryButton, buildRewriteButton } from './generation-buttons.js';

/** Telegram caps a message at 4096; leave room for the header and the tags */
const MAX_STORYBOARD_DISPLAY = 3500;

const HELP_HEADER = [
    '🎬 生成视频用法',
    '',
    '`/vid 想法` — 说一句想要什么，Grok 会把它写成分镜再交给 H3 出片',
    '回复一张图片再 `/vid 想法` — 那张图作为人物/画风参考',
    '`/vidunsafe` 与 `/vid` 完全一样，只是出片不打遮罩',
    '',
    '可选参数写在想法前面或后面都行，但必须是 `-名字=值`，等号两边不能有空格：',
    '`-d=` 秒数(1-15，默认 5)　`-ar=16:9`　`-size=608x352`(32 的倍数)　`-mp=` 像素量',
    '`-steps=` 步数(Turbo 只能 4-8，Base 随意)　`-seed=` 种子　`-lora=` 强度　`-lowvram=1`',
    '`-ref=match|max`(参考图处理，max 更慢但更像)　`-sampler=`(仅 Base)',
    '`-shots=` 分镜数(1-5)　`-raw=1` 我自己写好了 H3 提示词，别改',
    '',
    '两个正交的开关：',
    '`-w=` 采样方案 —— 不写用 Turbo(6 步，快)，`-w=base` 用 24 步质量模式',
    '`-mode=` 参考方式 —— `ref2va` 图片只管人物/画风(默认)，`i2va` 图片锁成第一帧，',
    '　　　　`fl2va` 两张图锁首尾帧，`t2va` 纯文本',
    '',
    '`-ar` 写的是 宽:高 —— 竖屏是 `9:16`，`21:9` 是比 16:9 更宽的横屏。',
    '1:4 到 4:1 之间的任意比例都行，小数也行：`5:4`、`16:10`、`2.39:1`。',
    '只有一张参考图又没写 `-ar` 时，画幅直接跟那张图走。',
    '',
    '例：`/vid -d=8 -ar=9:16 雨夜的香港街头，红色电车驶过`',
    '例：回复一张图 `/vid -mode=i2va 镜头缓缓推进，她转头看向窗外`',
].join('\n');

/** The help ends with what the server currently offers, not a hardcoded list */
const buildHelpText = async (): Promise<string> => {
    const workflows = await listWorkflows();
    const videoWorkflows = workflows.filter(
        (workflow) => mediaKindOfWorkflow(workflow.kind) === 'video'
    );
    if (videoWorkflows.length === 0) return `${HELP_HEADER}\n\n（服务端当前没有出视频的工作流）`;

    const lines = videoWorkflows.map((workflow) => `· \`${workflow.id}\` — ${workflow.name}`);
    return `${HELP_HEADER}\n\n当前可用工作流：\n${lines.join('\n')}`;
};

interface RunTarget {
    api: Api;
    chatId: number;
    /** The message everything replies to */
    userMessageId: number;
    /** Where reference images may be attached: the reply target and the command */
    sourceMessageIds: Array<number | undefined>;
}

const replyWith = async (target: RunTarget, text: string): Promise<void> => {
    await to(
        target.api.sendMessage(target.chatId, text, {
            reply_parameters: { message_id: target.userMessageId },
            parse_mode: 'Markdown',
        })
    );
};

/** Whether this message is a vid command at all (chat-handler's routing gate) */
export const checkVidCommand = (ctx: Context): boolean =>
    parseVidCommand(ctx.message?.text ?? ctx.message?.caption).type !== 'none';

const escapeHtml = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The storyboard, folded away. It is 400 words of English prose that most of
 * the group does not want to scroll past, but the person who asked for the
 * video does want to be able to read, correct and re-use with `-raw=1`.
 */
const storyboardMessage = (storyboard: string): string => {
    const shown =
        storyboard.length > MAX_STORYBOARD_DISPLAY
            ? `${storyboard.slice(0, MAX_STORYBOARD_DISPLAY)}…`
            : storyboard;
    return `🎬 分镜<blockquote expandable>${escapeHtml(shown)}</blockquote>`;
};

interface Storyboard {
    prompt: string;
    /** Set when Grok failed and the user's own words are being sent instead */
    degradedReason?: string;
}

/**
 * Ask Grok for a storyboard, and post it. A failure here is not fatal: a minute
 * of the user's waiting has already been spent, and H3 does accept plain
 * English, so their own words go through with an explanation attached.
 */
const writeStoryboard = async (
    target: RunTarget,
    spec: VidCommandSpec,
    plan: VideoPlan,
    replan: () => Promise<void>
): Promise<Storyboard> => {
    const noticeResult = await to(
        target.api.sendMessage(target.chatId, '🎬 正在写分镜…', {
            reply_parameters: { message_id: target.userMessageId },
        })
    );
    const noticeId = noticeResult[1]?.message_id;

    const [error, storyboard] = await to(
        enhanceVideoPrompt({
            brief: spec.brief,
            mode: plan.mode,
            durationSeconds: plan.durationSeconds,
            aspectRatio: plan.sendAspectRatio ? plan.aspectRatio : null,
            shots: plan.shots,
            referenceImages: plan.referenceImages,
        })
    );

    const rewriteMarkup = buildRewriteButton(rememberAction(replan));

    if (error) {
        const reason = error instanceof H3PromptError ? error.userReason : error.message;
        console.warn('[vid] storyboard failed, falling back to the raw brief:', error.message);
        const text = `⚠️ ${reason}，直接用你的原话生成`;
        if (noticeId === undefined) {
            await to(
                target.api.sendMessage(target.chatId, text, {
                    reply_parameters: { message_id: target.userMessageId },
                    reply_markup: rewriteMarkup,
                })
            );
        } else {
            await to(
                target.api.editMessageText(target.chatId, noticeId, text, {
                    reply_markup: rewriteMarkup,
                })
            );
        }
        return { prompt: spec.brief, degradedReason: reason };
    }

    const text = storyboardMessage(storyboard);
    if (noticeId === undefined) {
        await to(
            target.api.sendMessage(target.chatId, text, {
                reply_parameters: { message_id: target.userMessageId },
                parse_mode: 'HTML',
                reply_markup: rewriteMarkup,
            })
        );
    } else {
        await to(
            target.api.editMessageText(target.chatId, noticeId, text, {
                parse_mode: 'HTML',
                reply_markup: rewriteMarkup,
            })
        );
    }

    return { prompt: storyboard };
};

const startRun = async (target: RunTarget, spec: VidCommandSpec): Promise<void> => {
    const referenceImages = await collectReferenceImages(target.chatId, target.sourceMessageIds);

    const planned = planVideoGeneration({
        spec,
        workflows: await listWorkflows(),
        referenceImages,
    });
    if (!planned.ok) {
        await replyWith(target, planned.reason);
        return;
    }
    const { plan } = planned;

    if (spec.negativeIgnored) {
        await replyWith(target, 'H3 不吃负面提示词，`-:` 后面的内容已经忽略');
    }
    if (plan.extraReferenceImages > 0) {
        const total = plan.extraReferenceImages + plan.referenceImages.length;
        await replyWith(
            target,
            `这条消息里有 ${total} 张图，\`${plan.workflow.id}\` 只吃前 ${plan.referenceImages.length} 张`
        );
    }

    // Pressing ✍️ redoes everything from the idea — including re-reading the
    // reference images, which is why they were never kept in memory
    const replan = (): Promise<void> => startRun(target, spec);

    let storyboard: Storyboard = { prompt: spec.brief };
    if (!spec.raw) {
        if (!isH3EnhancerConfigured()) {
            await replyWith(target, '没有配置 Grok，直接用你的原话生成（想自己写分镜可以加 `-raw=1`）');
        } else {
            // Check the box is up BEFORE spending a minute on a storyboard for
            // a video that cannot be made
            const health = await checkHealth();
            if (!health.ok) {
                await to(
                    target.api.sendMessage(target.chatId, health.reason ?? '生成服务未启动', {
                        reply_parameters: { message_id: target.userMessageId },
                        reply_markup: buildRetryButton(rememberAction(replan)),
                    })
                );
                return;
            }
            storyboard = await writeStoryboard(target, spec, plan, replan);
        }
    }

    const request = buildVideoRequest(plan, spec, storyboard.prompt);

    console.log('[vid] submitting', {
        workflow: request.workflow,
        mode: plan.mode,
        promptLength: request.prompt.length,
        images: plan.referenceImages.length,
        imageFields: ['input_image', 'first_frame', 'last_frame', 'reference_images'].filter(
            (field) => Reflect.get(request, field) !== undefined
        ),
        degraded: storyboard.degradedReason,
        options: request.options,
        spoiler: spec.spoiler,
    });

    await runGeneration({
        api: target.api,
        chatId: target.chatId,
        userMessageId: target.userMessageId,
        kind: 'video',
        request,
        spoiler: spec.spoiler,
        workflowName: plan.workflow.name,
    });
};

/**
 * Handle a vid command. Assumes `checkVidCommand` already said yes; never
 * throws (chat-handler runs it detached from grammy's error handling).
 */
export const handleVidCommand = async (ctx: Context): Promise<void> => {
    if (!ctx.message || !ctx.chat) return;

    const target: RunTarget = {
        api: ctx.api,
        chatId: ctx.chat.id,
        userMessageId: ctx.message.message_id,
        sourceMessageIds: [ctx.message.reply_to_message?.message_id, ctx.message.message_id],
    };

    if (!isComfyConfigured()) {
        await replyWith(target, '生成服务未配置');
        return;
    }

    const parsed = parseVidCommand(ctx.message.text ?? ctx.message.caption);
    if (parsed.type === 'none') return;

    // One wrong parameter used to bury the answer under the whole help text
    if (parsed.type === 'invalid') {
        await replyWith(target, `${parsed.reason}\n\n完整用法：单独发一条 \`/vid\``);
        return;
    }

    if (!parsed.spec.brief) {
        await replyWith(target, await buildHelpText());
        return;
    }

    const [error] = await to(startRun(target, parsed.spec));
    if (error) {
        console.error('[vid] unhandled failure:', error);
        await replyWith(target, `生成视频失败：${error.message}`);
    }
};
