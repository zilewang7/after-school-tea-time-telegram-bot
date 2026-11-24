/**
 * Neutral Chinese category of a stored Telegram message type, and the one-line
 * summary user-facing surfaces show for a message with no words of its own.
 *
 * The model-facing annotation is English (`[service: …]`, `[sent a poll: …]`)
 * and is built from `telegram_messages.messageKind` + `messageDetail` by
 * `src/db/message-kind.ts`. User-facing surfaces — the `/context` command, the
 * panel's conversation list, a public share page, the status page's trigger
 * summary — must not show that detail (it may carry a phone number or
 * coordinates) and must not leave a blank either: they show one neutral
 * category word instead.
 *
 * Lives in `shared` (layer 0) so every surface that renders such a summary can
 * use it. The token list mirrors `MessageKind` in `src/db/message-kind.ts`;
 * that module is a higher layer, so it cannot be imported here.
 */
const KIND_CATEGORY_LABELS: Readonly<Record<string, string>> = {
    poll: '投票',
    quiz: '测验',
    dice: '骰子',
    location: '位置',
    live_location: '实时位置',
    venue: '地点',
    contact: '联系人',
    checklist: '清单',
    game: '游戏',
    invoice: '账单',
    paid_media: '付费媒体',
    story: '故事',
    widget: '卡片',
    service: '群系统事件',
    unsupported: '未接入消息',
};

/**
 * The neutral category of a stored kind token; null when the row has no type.
 * A token this build does not know still gets a neutral word rather than a
 * blank, so a newer row cannot make an older panel look broken.
 */
export const messageKindCategoryLabelOf = (storedKind: string | null): string | null =>
    storedKind === null ? null : (KIND_CATEGORY_LABELS[storedKind] ?? '消息');

/** The fields a neutral summary is built from; every surface passes what it read */
export interface MessageSummaryFields {
    readonly text?: string | null;
    readonly chatCommand?: string | null;
    readonly mediaHint?: string | null;
    readonly messageKind?: string | null;
}

/**
 * One neutral line for a message that has no words of its own: its words,
 * the `/chat` marker, a type category, or the media hint. Empty when nothing
 * about the row is known (an old row stored before these columns existed).
 */
export const messageSummaryTextOf = (message: MessageSummaryFields): string => {
    const words = message.text?.trim() ?? '';
    if (words !== '') return words;
    if (message.chatCommand) return '[/chat]';
    const category = messageKindCategoryLabelOf(message.messageKind ?? null);
    if (category !== null) return `[${category}]`;
    if (message.mediaHint) return `[${message.mediaHint}]`;
    return '';
};
