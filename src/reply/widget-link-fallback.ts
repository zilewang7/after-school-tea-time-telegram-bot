/**
 * The group-chat form of a widget: one text message that opens the card in the
 * Mini App and previews the reply's share page.
 *
 * Telegram accepts widgets only in private chats, so a group gets a link
 * instead. Everything that decides that shape is a pure function here, so the
 * fallback is testable without Telegram, a renderer or a share service.
 */
import { GrammyError } from 'grammy';
import type { LinkPreviewOptions, MessageEntity } from 'grammy/types';
import type { ImageCaptionFields } from './tools/image-message.js';

/** The visible text of the Mini App link; the emoji is part of the link */
export const WIDGET_LINK_LABEL = '🧩 在 Mini App 查看这张卡片';

/** Chat kinds a widget can be delivered to; grammY's ctx.chat.type */
export type WidgetChatType = 'private' | 'group' | 'supergroup' | 'channel';

export interface WidgetDeliveryInput {
    readonly chatType: WidgetChatType | undefined;
    /** WIDGET_GROUP_FALLBACK: groups get the Mini App link instead of nothing */
    readonly groupFallback: boolean;
    /** SHARE_ENABLED: the link fallback's preview page exists */
    readonly shareEnabled: boolean;
    /** The 600px card image rendered */
    readonly renderOk: boolean;
    /** The reply's share page was created, so the link can preview it */
    readonly shareOk: boolean;
    /** A private-chat send was refused with INPUT_MEDIA_WIDGET_NOT_ALLOWED */
    readonly serverRejected?: boolean;
}

export interface WidgetDeliveryPlan {
    /** Native widget in a private chat, Mini App link fallback, or nothing */
    readonly kind: 'widget' | 'link' | 'none';
    /** Keep the rendered PNG on the session, the version and the bot row */
    readonly keepImage: boolean;
    /** Ask Telegram for the large share-page preview */
    readonly withPreview: boolean;
}

/**
 * Which shape this chat gets. A private chat takes the native widget until the
 * server refuses it; groups take the link fallback only when both the fallback
 * switch and the share pages are on (the page is the preview's landing spot).
 */
export const resolveWidgetDelivery = (input: WidgetDeliveryInput): WidgetDeliveryPlan => {
    const isPrivate = input.chatType === 'private';
    const nativeAllowed = isPrivate && input.serverRejected !== true;
    const fallbackAllowed =
        input.serverRejected === true || (input.chatType !== undefined && !isPrivate);
    const kind: WidgetDeliveryPlan['kind'] = nativeAllowed
        ? 'widget'
        : fallbackAllowed && input.groupFallback && input.shareEnabled
          ? 'link'
          : 'none';
    return {
        kind,
        keepImage: kind !== 'none' && input.renderOk,
        withPreview: kind === 'link' && input.shareOk,
    };
};

export interface MiniAppReplyLinkInput {
    readonly botUsername: string;
    /** WEBAPP_BOT_SHORT_NAME: the Mini App's direct-link short name */
    readonly shortName: string;
    readonly chatId: number;
    readonly firstMessageId: number;
}

/**
 * WEBAPP_BOT_SHORT_NAME: the Mini App direct link's short name. Production and
 * the test instance both use `panel`; unset falls back to it.
 */
export const miniAppShortName = (): string => process.env.WEBAPP_BOT_SHORT_NAME?.trim() || 'panel';

/** `https://t.me/<bot>/<short>?startapp=r<chatId>_<firstMessageId>`: this reply, in the Mini App */
export const miniAppReplyLink = (input: MiniAppReplyLinkInput): string =>
    `https://t.me/${input.botUsername}/${input.shortName}` +
    `?startapp=r${input.chatId}_${input.firstMessageId}`;

export interface WidgetLinkMessageInput {
    /** The caption the card would have gone out with, already rendered and fitted */
    readonly caption?: ImageCaptionFields;
    /** The reply's share page; absent when the share service is unavailable */
    readonly shareUrl?: string;
    readonly miniAppLink: string;
    readonly replyToMessageId?: number;
}

export interface WidgetLinkMessage {
    readonly text: string;
    readonly entities: MessageEntity[];
    /** The large share-page preview; absent = Telegram's own card for the t.me link */
    readonly linkPreviewOptions?: LinkPreviewOptions;
    readonly replyParameters?: { readonly message_id: number };
}

/**
 * The one text message a group widget goes out as: the caption (when the model
 * wrote one), then the link line. Entities are UTF-16 offsets into the joined
 * text, so the caption's own entities shift by the caption plus its newline.
 */
export const buildWidgetLinkMessage = (input: WidgetLinkMessageInput): WidgetLinkMessage => {
    const caption = input.caption?.caption ?? '';
    const text = caption.length > 0 ? `${caption}\n${WIDGET_LINK_LABEL}` : WIDGET_LINK_LABEL;
    const linkOffset = caption.length > 0 ? caption.length + 1 : 0;
    const entities: MessageEntity[] = [
        ...(input.caption?.caption_entities ?? []),
        {
            type: 'text_link',
            offset: linkOffset,
            length: WIDGET_LINK_LABEL.length,
            url: input.miniAppLink,
        },
    ];
    return {
        text,
        entities,
        ...(input.shareUrl !== undefined && input.shareUrl.length > 0
            ? {
                  linkPreviewOptions: {
                      url: input.shareUrl,
                      prefer_large_media: true,
                      show_above_text: true,
                  } satisfies LinkPreviewOptions,
              }
            : {}),
        ...(input.replyToMessageId !== undefined
            ? { replyParameters: { message_id: input.replyToMessageId } }
            : {}),
    };
};

/** The private-chat refusal that means "this server does not take widgets here" */
export const isWidgetNotAllowedError = (error: unknown): boolean => {
    const description =
        error instanceof GrammyError
            ? error.description
            : error instanceof Error
              ? error.message
              : String(error);
    return /INPUT_MEDIA_WIDGET_NOT_ALLOWED/i.test(description);
};
