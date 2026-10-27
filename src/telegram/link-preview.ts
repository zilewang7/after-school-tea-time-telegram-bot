/**
 * Link-preview options used when sending/editing messages.
 *
 * Field names mirror the Bot API object so these values can be handed to
 * grammy unchanged. Only the fields this bot sets are spelled out.
 */
export interface LinkPreviewOptions {
    is_disabled?: boolean;
    url?: string;
    prefer_small_media?: boolean;
    prefer_large_media?: boolean;
    show_above_text?: boolean;
}

/** Suppress the preview on a message that should not carry a card */
export const disabledLinkPreview: LinkPreviewOptions = { is_disabled: true };
