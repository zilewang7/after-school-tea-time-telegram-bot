/**
 * The avatar lane of fetch_image: one target string → the profile picture the
 * model can look at, registered as `imgN` so send_image, generate_image and
 * search_by_image use it exactly like any other fetched picture.
 *
 * A target read twice in the same reply is answered from the conversation: the
 * bytes are already there, only the id matters for the next call.
 */
import {
    avatarTargetKey,
    resolveAvatar,
    type AvatarDependencies,
    type AvatarView,
} from '../../services/avatar-service.js';
import type { ContextIndex } from '../context-index.js';
import { parseAvatarTarget } from './avatar-args.js';
import { formatAvatarResult, formatAvatarReuse } from './image-tool-text.js';
import { laneSummaryOf, type LaneOutcome } from './fetch-image-lane-types.js';
import type { ReplyMediaState } from './reply-media-state.js';

export interface AvatarLaneOptions {
    /** The chat this reply happens in: `avatar='chat'` */
    readonly chatId: number;
    readonly botUserId: number | null;
    /** `#N` → the author whose avatar the model wants */
    readonly contextIndex: ContextIndex;
    readonly dependencies: AvatarDependencies;
}

/** One avatar target → the picture, or the reason it cannot be read */
export const readAvatarSource = async (
    text: string,
    view: AvatarView,
    state: ReplyMediaState,
    options: AvatarLaneOptions,
    signal: AbortSignal
): Promise<LaneOutcome> => {
    const parsed = parseAvatarTarget(text, {
        chatId: options.chatId,
        botUserId: options.botUserId,
        contextIndex: options.contextIndex,
    });
    if (!parsed.ok) return { ok: false, error: parsed.error };

    const key = `${avatarTargetKey(parsed.target)}:${view}`;
    const existingId = state.readAvatars.get(key);
    if (existingId !== undefined) {
        const label = state.fetched.get(existingId)?.title ?? '头像';
        return {
            ok: true,
            status: 'reuse',
            id: existingId,
            content: formatAvatarReuse(existingId, label),
            traceResult: '已读过',
        };
    }

    const resolved = await resolveAvatar(
        parsed.target,
        { view, signal },
        { ...options.dependencies, botUserId: options.botUserId }
    );
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { avatar } = resolved;
    const tier = view === 'thumbnail' ? '160 档缩略图' : '640 档';

    return {
        ok: true,
        status: 'read',
        read: {
            kind: 'image',
            data: avatar.data,
            mimeType: avatar.mimeType,
            register: (id) => {
                state.fetched.set(id, {
                    id,
                    data: avatar.data,
                    mimeType: avatar.mimeType,
                    still: { data: avatar.data, mimeType: avatar.mimeType },
                    sourcePage: '',
                    title: avatar.label,
                    imageUrl: '',
                });
                state.readAvatars.set(key, id);
            },
            materialize: (id) => ({
                content: formatAvatarResult({
                    id,
                    label: avatar.label,
                    mimeType: avatar.mimeType,
                    dataLength: avatar.data.length,
                    view,
                }),
                caption: `头像 ${id}：${avatar.label}`,
                traceResult: `${id} 头像 ${view === 'thumbnail' ? '160 档' : '640 档'}`,
            }),
            summary: laneSummaryOf({
                label: `${avatar.label}（${tier}）`,
                mimeType: avatar.mimeType,
                dataLength: avatar.data.length,
            }),
            sourcePage: null,
        },
    };
};
