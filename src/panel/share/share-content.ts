/**
 * What a share page shows, read from the database (design §5.7).
 *
 * A reply share is pinned to one version of one bot response; a conversation
 * share renders the whole reply tree as chat bubbles (user display names
 * included — only members may create one). Everything here is read-only: no
 * backfill, no process state, no media bytes for the page itself (the media
 * routes load the one attachment a page displays, on demand).
 */
import {
    findBotResponseInChat,
    findRootMessage,
    getContextMessage,
    getRepliesHistory,
    listBotResponsesByIds,
    type ContextMessage,
} from '../../db/queries/context-queries.js';
import { findChat } from '../../db/queries/panel-registry.js';
import type { BotResponse, ResponseVersion } from '../../db/index.js';
import {
    loadLinkPreviewMediaDescriptors,
    loadMessageMediaDescriptors,
    versionMediaDescriptorOf,
    type MediaDescriptor,
} from '../media/media-content.js';
import type { PreviewSnapshot } from './share-types.js';

export interface ShareWidgetContent {
    html: string;
    caption: string | null;
    /** 600px render stored with the version; the share preview no longer uses it */
    imageBase64: string | null;
}

/** The attachment facts a share page renders; the media route serves the bytes */
export type ShareMedia = MediaDescriptor;

export interface ShareReplyContent {
    kind: 'reply';
    chatId: number;
    chatTitle: string | null;
    firstMessageId: number;
    versionId: number;
    /** 1-based position among the reply's versions */
    versionNumber: number;
    createdAt: string;
    model: string | null;
    text: string;
    widget: ShareWidgetContent | null;
    /** The version's attachment (image / sticker / video / file); bytes via the media route */
    media: ShareMedia | null;
    /** Server-side only: the snapshot the preview image is rendered from */
    preview: PreviewSnapshot;
}

export interface ShareUserBubble {
    kind: 'user';
    messageId: number;
    createdAt: string;
    authorName: string;
    text: string;
    mediaHint: string | null;
    /** The message's own attachment, when the 7-day retention still has it */
    media: ShareMedia | null;
    /** Pictures / clips Telegram crawled for the message's first URL */
    previewMedia: ShareMedia[];
}

export interface ShareBotBubble {
    kind: 'bot';
    messageId: number;
    createdAt: string;
    text: string;
    widget: ShareWidgetContent | null;
    /** The current version's attachment, when it has one */
    media: ShareMedia | null;
}

export type ShareBubble = ShareUserBubble | ShareBotBubble;

export interface ShareConversationContent {
    kind: 'conversation';
    chatId: number;
    chatTitle: string | null;
    rootId: number;
    bubbles: ShareBubble[];
    /** Server-side only: the newest bot reply that has something to draw */
    preview: PreviewSnapshot;
}

export type ShareContent = ShareReplyContent | ShareConversationContent;

const widgetOf = (version: ResponseVersion): ShareWidgetContent | null => {
    const widget = version.widget;
    if (widget === undefined) return null;
    return {
        html: widget.html,
        caption: widget.caption ?? null,
        imageBase64: widget.imageBase64 !== undefined && widget.imageBase64 !== '' ? widget.imageBase64 : null,
    };
};

const hasImageOf = (version: ResponseVersion): boolean =>
    typeof version.imageBase64 === 'string' && version.imageBase64 !== '';

/** The pinned version, or the current one when the pinned id no longer exists */
export const selectVersion = (response: BotResponse, versionId: number | null): { version: ResponseVersion; number: number } | null => {
    const versions = response.getVersions();
    if (versionId !== null) {
        const index = versions.findIndex((version) => version.versionId === versionId);
        const pinned = index < 0 ? undefined : versions[index];
        if (pinned !== undefined) return { version: pinned, number: index + 1 };
    }
    const current = response.getCurrentVersion();
    if (current === null) return null;
    return { version: current, number: response.currentVersionIndex + 1 };
};

const previewSnapshotOfReply = (
    chatTitle: string | null,
    version: ResponseVersion,
    widget: ShareWidgetContent | null
): PreviewSnapshot => {
    const widgetImageBase64 = widget?.imageBase64 ?? null;
    const imageBase64 = hasImageOf(version) ? (version.imageBase64 ?? '') : '';
    return {
        chatTitle,
        createdAt: version.createdAt,
        text: typeof version.text === 'string' ? version.text : '',
        ...(widget === null ? {} : { widgetHtml: widget.html }),
        ...(widgetImageBase64 === null ? {} : { widgetImageBase64 }),
        ...(imageBase64 === '' ? {} : { imageBase64 }),
        caption: widget?.caption ?? version.imageCaption ?? null,
    };
};

/** One reply's pinned version; null when the response or every version is missing */
export const loadReplyShareContent = async (
    chatId: number,
    firstMessageId: number,
    versionId: number | null
): Promise<ShareReplyContent | null> => {
    const response = await findBotResponseInChat(chatId, firstMessageId);
    if (response === null) return null;
    const selected = selectVersion(response, versionId);
    if (selected === null) return null;
    const { version, number } = selected;
    const chat = await findChat(chatId);
    const chatTitle = chat?.title ?? null;
    const widget = widgetOf(version);
    return {
        kind: 'reply',
        chatId,
        chatTitle,
        firstMessageId,
        versionId: version.versionId,
        versionNumber: number,
        createdAt: version.createdAt,
        model: typeof version.model === 'string' && version.model !== '' ? version.model : null,
        text: typeof version.text === 'string' ? version.text : '',
        widget,
        media: versionMediaDescriptorOf(version),
        preview: previewSnapshotOfReply(chatTitle, version, widget),
    };
};

const userBubbleOf = (
    message: ContextMessage,
    media: ShareMedia | null,
    previewMedia: readonly ShareMedia[]
): ShareUserBubble => ({
    kind: 'user',
    messageId: message.messageId,
    createdAt: message.date.toISOString(),
    authorName: message.userName,
    text: message.text ?? '',
    mediaHint: message.mediaHint,
    media,
    previewMedia: [...previewMedia],
});

const botBubbleOf = (message: ContextMessage, response: BotResponse | undefined): ShareBotBubble => {
    const version = response?.getCurrentVersion() ?? null;
    return {
        kind: 'bot',
        messageId: message.messageId,
        createdAt: message.date.toISOString(),
        text: version !== null && typeof version.text === 'string' ? version.text : (message.text ?? ''),
        widget: version === null ? null : widgetOf(version),
        media: version === null ? null : versionMediaDescriptorOf(version),
    };
};

/** The preview snapshot of a conversation: its newest bot reply that has a widget */
const previewSnapshotOfConversation = (
    chatTitle: string | null,
    ordered: readonly ContextMessage[],
    responses: ReadonlyMap<number, BotResponse>
): PreviewSnapshot => {
    for (const message of [...ordered].reverse()) {
        if (!message.fromBotSelf) continue;
        const version = responses.get(message.messageId)?.getCurrentVersion() ?? null;
        if (version === null) continue;
        const widget = widgetOf(version);
        if (widget !== null) return previewSnapshotOfReply(chatTitle, version, widget);
    }
    // No widget anywhere: the snapshot is text only, so the page has no image
    const newestText = [...ordered].reverse().find((message) => (message.text ?? '') !== '');
    return {
        chatTitle,
        createdAt: (newestText ?? ordered[ordered.length - 1])?.date.toISOString() ?? new Date(0).toISOString(),
        text: newestText?.text ?? '',
    };
};

/**
 * The whole reply tree rooted at `rootId`, oldest first; null unless `rootId`
 * is a stored message and the root of its own chain (same rule as the panel's
 * conversation endpoints).
 */
export const loadConversationShareContent = async (
    chatId: number,
    rootId: number
): Promise<ShareConversationContent | null> => {
    const root = await getContextMessage(chatId, rootId);
    if (root === null) return null;
    const chainRoot = await findRootMessage(chatId, rootId, { recover: false });
    if (chainRoot?.messageId !== rootId) return null;

    const messages = await getRepliesHistory(chatId, rootId, { recover: false });
    const ordered = [...messages].sort((a, b) => a.messageId - b.messageId);
    const botMessageIds = ordered.filter((message) => message.fromBotSelf).map((message) => message.messageId);
    const responses = await listBotResponsesByIds(chatId, botMessageIds);
    const responseById = new Map(responses.map((response) => [response.messageId, response]));
    const userMessages = ordered.filter((message) => !message.fromBotSelf);
    const userMedia = await loadMessageMediaDescriptors(userMessages);
    const userPreviewMedia = await loadLinkPreviewMediaDescriptors(userMessages);

    const chat = await findChat(chatId);
    const chatTitle = chat?.title ?? null;
    return {
        kind: 'conversation',
        chatId,
        chatTitle,
        rootId,
        bubbles: ordered.map((message) =>
            message.fromBotSelf
                ? botBubbleOf(message, responseById.get(message.messageId))
                : userBubbleOf(
                    message,
                    userMedia.get(message.messageId) ?? null,
                    userPreviewMedia.get(message.messageId) ?? []
                )
        ),
        preview: previewSnapshotOfConversation(chatTitle, ordered, responseById),
    };
};

/** A share's page content, by its stored target */
export const loadShareContent = async (input: {
    kind: 'reply' | 'conversation';
    chatId: number;
    firstMessageId: number | null;
    rootId: number | null;
    versionId: number | null;
}): Promise<ShareContent | null> => {
    if (input.kind === 'reply') {
        if (input.firstMessageId === null) return null;
        return loadReplyShareContent(input.chatId, input.firstMessageId, input.versionId);
    }
    if (input.rootId === null) return null;
    return loadConversationShareContent(input.chatId, input.rootId);
};

/** The widgets a page shows, in iframe order (`/s/<token>/widget/<index>`) */
export const widgetsOfContent = (content: ShareContent): ShareWidgetContent[] => {
    if (content.kind === 'reply') return content.widget === null ? [] : [content.widget];
    return content.bubbles.flatMap((bubble) =>
        bubble.kind === 'bot' && bubble.widget !== null ? [bubble.widget] : []
    );
};
