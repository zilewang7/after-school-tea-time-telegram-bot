// Public resources of a share page: same origin, no initData — the token is the permission.

export type ShareMediaSlot = 'image' | 'file';

/**
 * The document a share's widget iframe loads. The index follows the SSR page
 * order: a reply share has one widget (0); a conversation share numbers the
 * widgets of its bot bubbles in bubble order.
 */
export const shareWidgetUrlOf = (token: string, index: number): string =>
    `/s/${encodeURIComponent(token)}/widget/${index}`;

/** One attachment of the shared content; the server refuses media the share does not expose */
export const shareMediaUrlOf = (token: string, messageId: number, slot: ShareMediaSlot): string =>
    `/s/${encodeURIComponent(token)}/media/${messageId}/${slot}`;
