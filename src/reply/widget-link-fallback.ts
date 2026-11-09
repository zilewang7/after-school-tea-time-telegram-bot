/**
 * The group-chat form of a widget: one text message that opens the card in the
 * Mini App. It carries the caption as its own text (a short line when the model
 * wrote none) and previews the share page, whose og:image is the widget render.
 *
 * Telegram accepts widgets only in private chats, so a group gets a link
 * instead. Everything that decides that shape is a pure function here, so the
 * fallback is testable without Telegram, a renderer or a share service.
 */
import { GrammyError } from 'grammy';
import type { LinkPreviewOptions, MessageEntity } from 'grammy/types';
import type { ImageCaptionFields } from './tools/image-message.js';

/** The visible text of a caption-less Mini App link; the emoji is part of the link */
export const WIDGET_LINK_LABEL = '🧩 查看卡片';

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

export interface MiniAppShareLinkInput {
    readonly botUsername: string;
    readonly shortName: string;
    readonly token: string;
}

/** `https://t.me/<bot>/<short>?startapp=s<token>`: the public share, in the Mini App */
export const miniAppShareLink = (input: MiniAppShareLinkInput): string =>
    `https://t.me/${input.botUsername}/${input.shortName}?startapp=s${input.token}`;

export interface WidgetMiniAppLinkInput extends MiniAppReplyLinkInput {
    /** The reply's share page token; when present the link opens the public share */
    readonly shareToken: string | null;
}

/**
 * The Mini App deep link of a link-fallback message: the public share when the
 * share page exists (so non-members can read it too), else the reply itself.
 */
export const widgetMiniAppLink = (input: WidgetMiniAppLinkInput): string =>
    input.shareToken === null
        ? miniAppReplyLink(input)
        : miniAppShareLink({
              botUsername: input.botUsername,
              shortName: input.shortName,
              token: input.shareToken,
          });

export interface WidgetLinkMessageInput {
    /** The caption the card would have gone out with, already rendered and fitted */
    readonly caption?: ImageCaptionFields;
    /** The share page in preview mode; absent = no forced large preview */
    readonly previewUrl?: string;
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
 * Entities the whole-text Mini App link cannot carry: a second link would be
 * shadowed by it, and a block entity under a link is not something Telegram is
 * known to keep. The text stays; only its formatting is dropped.
 */
const SHADOWED_ENTITY_TYPES: ReadonlySet<MessageEntity['type']> = new Set<MessageEntity['type']>([
    'text_link',
    'url',
    'pre',
    'blockquote',
    'expandable_blockquote',
]);

const captionEntitiesFor = (caption: string, fields: ImageCaptionFields | undefined): MessageEntity[] => {
    const entities = fields?.caption_entities ?? [];
    // Anything outside the caption text would be rejected anyway
    return entities.filter(
        (entity) =>
            !SHADOWED_ENTITY_TYPES.has(entity.type) &&
            entity.offset >= 0 &&
            entity.offset + entity.length <= caption.length
    );
};

/**
 * The one text message a group widget goes out as. With a caption the whole
 * text is that caption and the Mini App link covers all of it, so the message
 * reads as the card's own caption; without one, a single short line. Entities
 * are UTF-16 offsets into the same text, so the caption's formatting keeps its
 * offsets (Telegram keeps a text_link that overlaps inline styles).
 */
export const buildWidgetLinkMessage = (input: WidgetLinkMessageInput): WidgetLinkMessage => {
    const caption = input.caption?.caption ?? '';
    const hasCaption = caption.length > 0;
    const text = hasCaption ? caption : WIDGET_LINK_LABEL;
    const entities: MessageEntity[] = [
        ...(hasCaption ? captionEntitiesFor(caption, input.caption) : []),
        { type: 'text_link', offset: 0, length: text.length, url: input.miniAppLink },
    ];
    // Caption formatting may start at offset 0 too; keep the list ordered
    entities.sort((left, right) => left.offset - right.offset);
    return {
        text,
        entities,
        ...(input.previewUrl !== undefined && input.previewUrl.length > 0
            ? {
                  linkPreviewOptions: {
                      url: input.previewUrl,
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
