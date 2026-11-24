/**
 * Telegram message types that carry no ordinary text (harness issue #16).
 *
 * `telegram_messages.messageKind` is a machine token and `messageDetail` a
 * model-readable single-line English phrase; both are written by autoSave from
 * the incoming update and rendered by the context builder as header
 * annotations ([service: …], [sent a poll: …], [unsupported …]). This module is
 * pure — it reads a grammy Message and returns what to store — so the mapping
 * can be tested without a bot, and the history/panel layers can reuse it.
 *
 * `@grammyjs/types` 5.0.0 knows most Bot API 10.4 fields; the few it does not
 * (`widget`, `ton_wallet_transfer`, `paid_messages_waived`) are detected by
 * presence with the `in` operator rather than by a cast.
 */
import type { Chat, ChecklistTask, Giveaway, Message as TgMessage, User } from 'grammy/types';
import {
    SENT_ANNOTATION_PREFIX,
    SERVICE_ANNOTATION_PREFIX,
    SERVICE_UNSUPPORTED_EVENT_ANNOTATION,
    UNSUPPORTED_MESSAGE_ANNOTATION,
    UNSUPPORTED_MESSAGE_PREFIX,
    type LegendKey,
} from '../shared/context-markers.js';
import { formatUserDisplayName } from '../shared/user-display-name.js';

/** Message types that carry user content other than text */
export type ContentMessageKind =
    | 'poll'
    | 'quiz'
    | 'dice'
    | 'location'
    | 'live_location'
    | 'venue'
    | 'contact'
    | 'checklist'
    | 'game'
    | 'invoice'
    | 'paid_media'
    | 'story'
    | 'widget';

/** Machine tokens stored in `telegram_messages.messageKind` */
export type MessageKind = ContentMessageKind | 'service' | 'unsupported';

const MESSAGE_KINDS: readonly MessageKind[] = [
    'poll',
    'quiz',
    'dice',
    'location',
    'live_location',
    'venue',
    'contact',
    'checklist',
    'game',
    'invoice',
    'paid_media',
    'story',
    'widget',
    'service',
    'unsupported',
];

/** The stored token as a known kind; an unknown token (future/foreign row) reads as null */
export const parseMessageKind = (value: string | null): MessageKind | null =>
    value === null ? null : MESSAGE_KINDS.find((kind) => kind === value) ?? null;

/** What follows `[sent ` in a content message's annotation */
const CONTENT_KIND_LABELS = {
    poll: 'a poll',
    quiz: 'a quiz',
    dice: 'a dice roll',
    location: 'a location',
    live_location: 'a live location',
    venue: 'a venue',
    contact: 'a contact',
    checklist: 'a checklist',
    game: 'a game',
    invoice: 'an invoice',
    paid_media: 'paid media',
    story: 'a story',
    widget: 'an HTML widget',
} satisfies Record<ContentMessageKind, string>;

/** Longest detail kept; the renderer only wraps and stops at this too */
export const MESSAGE_DETAIL_MAX_CHARS = 300;

/** Control characters would break the one-line wire annotation: they become spaces */
const withoutControlCharacters = (text: string): string => {
    let cleaned = '';
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        cleaned += code < 0x20 || code === 0x7f ? ' ' : char;
    }
    return cleaned;
};

/** Collapse to one line and drop characters that would break the wire format */
const collapseOneLine = (text: string): string =>
    withoutControlCharacters(text)
        // The context wire format ends a message with this marker
        .replace(/<<EOF/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

/** One readable line, capped in codepoints (never splits an emoji) */
const excerptOf = (text: string, maxChars: number): string => {
    const collapsed = collapseOneLine(text);
    const chars = Array.from(collapsed);
    return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : collapsed;
};

/**
 * The detail as stored: single line, no `<<EOF`, at most
 * MESSAGE_DETAIL_MAX_CHARS codepoints. Empty input has no detail to store.
 */
export const sanitizeMessageDetail = (raw: string): string | null => {
    const cleaned = collapseOneLine(raw);
    if (cleaned === '') return null;
    return excerptOf(cleaned, MESSAGE_DETAIL_MAX_CHARS);
};

/** What one message turns out to be, ready for the two new columns */
export interface MessageContentKind {
    readonly kind: MessageKind;
    /** Single-line English phrase, no brackets; null when the kind says it all */
    readonly detail: string | null;
}

/** A stored kind rendered as the header annotation the model reads */
export const messageKindAnnotationOf = (
    storedKind: string | null,
    storedDetail: string | null
): string | null => {
    if (storedKind === null) return null;
    const kind = parseMessageKind(storedKind);
    const detail = storedDetail === null ? null : sanitizeMessageDetail(storedDetail);
    if (kind === null) {
        // A token this build does not know: still tell the model something
        return `${UNSUPPORTED_MESSAGE_PREFIX}${collapseOneLine(storedKind)}]`;
    }
    if (kind === 'unsupported') {
        return detail === null
            ? UNSUPPORTED_MESSAGE_ANNOTATION
            : `${UNSUPPORTED_MESSAGE_PREFIX}${detail}]`;
    }
    if (kind === 'service') {
        return detail === null ? SERVICE_UNSUPPORTED_EVENT_ANNOTATION : `${SERVICE_ANNOTATION_PREFIX}${detail}]`;
    }
    return detail === null
        ? `${SENT_ANNOTATION_PREFIX}${CONTENT_KIND_LABELS[kind]}]`
        : `${SENT_ANNOTATION_PREFIX}${CONTENT_KIND_LABELS[kind]}: ${detail}]`;
};

/** Legend key for a stored `messageKind` whenever `messageKindAnnotationOf` emits one */
export const messageKindLegendKeyOf = (storedKind: string | null): LegendKey | null => {
    if (storedKind === null) return null;
    const kind = parseMessageKind(storedKind);
    if (kind === null || kind === 'unsupported') return 'unsupported';
    if (kind === 'service') return 'service';
    return 'message-kind';
};

/**
 * The short label a reply annotation names for a message kind, e.g.
 * `[replying to 某某: a poll]` / `[replying to #2 某某 (a poll)]`.
 */
export const messageKindMediumLabelOf = (storedKind: string | null): string | null => {
    const kind = parseMessageKind(storedKind);
    if (kind === null) return null;
    if (kind === 'service') return 'a group event';
    if (kind === 'unsupported') return 'an unsupported message';
    return CONTENT_KIND_LABELS[kind];
};

/** `A`, `A and B`, `A, B and C` */
const formatNameList = (names: readonly string[]): string => {
    if (names.length <= 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

const userNameOf = (user: User): string =>
    formatUserDisplayName({ firstName: user.first_name, lastName: user.last_name });

const userNamesOf = (users: readonly User[]): string => formatNameList(users.map(userNameOf));

const chatLabelOf = (chat: Chat | undefined): string | null => {
    if (chat === undefined) return null;
    return chat.type === 'private'
        ? formatUserDisplayName({ firstName: chat.first_name, lastName: chat.last_name })
        : chat.title;
};

/** Seconds as a short human duration: `45s`, `12m`, `1h 5m`, `1 day` */
const durationOf = (seconds: number): string => {
    if (seconds >= 86_400) {
        const days = seconds / 86_400;
        return `${days} day${days === 1 ? '' : 's'}`;
    }
    if (seconds >= 3_600) {
        const hours = Math.floor(seconds / 3_600);
        const minutes = Math.floor((seconds % 3_600) / 60);
        return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    }
    if (seconds >= 60) {
        const minutes = Math.floor(seconds / 60);
        const rest = seconds % 60;
        return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
    }
    return `${seconds}s`;
};

/** A price in the smallest currency unit; Telegram Stars have no subunit */
const moneyOf = (currency: string, smallestUnits: number): string =>
    currency === 'XTR' ? `${smallestUnits} stars` : `${currency} ${(smallestUnits / 100).toFixed(2)}`;

/** UTC instant for scheduled events, e.g. 2026-11-24T07:00:00.000Z */
const utcOf = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString();

const mediaCountPhrase = (counts: { photos: number; videos: number; previews: number }): string => {
    const parts: string[] = [];
    if (counts.photos > 0) parts.push(`${counts.photos} photo${counts.photos === 1 ? '' : 's'}`);
    if (counts.videos > 0) parts.push(`${counts.videos} video${counts.videos === 1 ? '' : 's'}`);
    if (counts.previews > 0) parts.push(`${counts.previews} preview${counts.previews === 1 ? '' : 's'}`);
    return formatNameList(parts);
};

const describePoll = (msg: TgMessage): MessageContentKind | null => {
    const poll = msg.poll;
    if (poll === undefined) return null;
    const options = poll.options.map((option) => collapseOneLine(option.text)).join(' / ');
    const flags = [
        ...(poll.is_anonymous ? ['anonymous'] : []),
        ...(poll.allows_multiple_answers ? ['multiple answers'] : []),
        ...(poll.is_closed ? ['closed'] : []),
    ];
    const suffix = flags.length > 0 ? ` (${flags.join(', ')})` : '';
    return {
        kind: poll.type === 'quiz' ? 'quiz' : 'poll',
        detail: `"${collapseOneLine(poll.question)}" — ${poll.options.length} options: ${options}${suffix}`,
    };
};

const describeChecklist = (msg: TgMessage): MessageContentKind | null => {
    const checklist = msg.checklist;
    if (checklist === undefined) return null;
    const done = checklist.tasks.filter((task) => (task.completion_date ?? 0) > 0).length;
    const tasks = checklist.tasks.map((task) => collapseOneLine(task.text)).join(' / ');
    return {
        kind: 'checklist',
        detail: `"${collapseOneLine(checklist.title)}" — ${checklist.tasks.length} tasks (${done} done): ${tasks}`,
    };
};

const describePaidMedia = (msg: TgMessage): MessageContentKind | null => {
    const paidMedia = msg.paid_media;
    if (paidMedia === undefined) return null;
    const counts = { photos: 0, videos: 0, previews: 0 };
    for (const item of paidMedia.paid_media) {
        if (item.type === 'photo' || item.type === 'live_photo') counts.photos += 1;
        else if (item.type === 'video') counts.videos += 1;
        else counts.previews += 1;
    }
    return {
        kind: 'paid_media',
        detail: `${mediaCountPhrase(counts)}, ${paidMedia.star_count} stars (paid content not viewable)`,
    };
};

/** Message types that carry user content other than plain text */
const describeContentKind = (msg: TgMessage): MessageContentKind | null => {
    const poll = describePoll(msg);
    if (poll !== null) return poll;

    if (msg.dice !== undefined) {
        return { kind: 'dice', detail: `${msg.dice.emoji} ${msg.dice.value}` };
    }

    // A venue carries a location too; the venue is the more specific type
    if (msg.venue !== undefined) {
        const venue = msg.venue;
        return {
            kind: 'venue',
            detail:
                `${collapseOneLine(venue.title)} — ${collapseOneLine(venue.address)} ` +
                `(${venue.location.latitude}, ${venue.location.longitude})`,
        };
    }

    if (msg.location !== undefined) {
        const location = msg.location;
        return {
            kind: location.live_period === undefined ? 'location' : 'live_location',
            detail: `${location.latitude}, ${location.longitude}`,
        };
    }

    if (msg.contact !== undefined) {
        const contact = msg.contact;
        const name = formatUserDisplayName({
            firstName: contact.first_name,
            lastName: contact.last_name,
        });
        const vcard = contact.vcard === undefined ? '' : ', has vCard';
        return { kind: 'contact', detail: `${name}, ${contact.phone_number}${vcard}` };
    }

    const checklist = describeChecklist(msg);
    if (checklist !== null) return checklist;

    if (msg.game !== undefined) {
        return { kind: 'game', detail: `"${collapseOneLine(msg.game.title)}"` };
    }

    if (msg.invoice !== undefined) {
        const invoice = msg.invoice;
        return {
            kind: 'invoice',
            detail: `"${collapseOneLine(invoice.title)}" — ${moneyOf(invoice.currency, invoice.total_amount)}`,
        };
    }

    const paidMedia = describePaidMedia(msg);
    if (paidMedia !== null) return paidMedia;

    if (msg.story !== undefined) {
        const from = chatLabelOf(msg.story.chat);
        return { kind: 'story', detail: from === null ? null : `from ${from}` };
    }

    // Bot API 10.4 widget: absent from @grammyjs/types 5.0.0
    if ('widget' in msg) return { kind: 'widget', detail: null };

    return null;
};

const describeMemberEvent = (msg: TgMessage): string | null => {
    const members = msg.new_chat_members;
    if (members !== undefined && members.length > 0) {
        // A user who joined by themselves is the sender: "joined", not "added"
        const joined = members.length === 1 && members[0]?.id === msg.from?.id;
        return joined ? 'joined the group' : `added ${userNamesOf(members)} to the group`;
    }
    const left = msg.left_chat_member;
    if (left !== undefined) {
        return left.id === msg.from?.id
            ? 'left the group'
            : `removed ${userNameOf(left)} from the group`;
    }
    return null;
};

const describeChatProfileEvent = (msg: TgMessage): string | null => {
    if (msg.new_chat_title !== undefined) {
        return `changed the group title to "${collapseOneLine(msg.new_chat_title)}"`;
    }
    if (msg.new_chat_photo !== undefined) return 'changed the group photo';
    if (msg.delete_chat_photo) return 'removed the group photo';
    if (msg.chat_background_set !== undefined) return 'changed the chat background';
    return null;
};

const pinnedMessageDetail = (msg: TgMessage): string | null => {
    const pinned = msg.pinned_message;
    if (pinned === undefined) return null;
    const summary = pinned.text ?? pinned.caption;
    return summary === undefined
        ? 'pinned a message'
        : `pinned a message: "${excerptOf(summary, 40)}"`;
};

const describePinAndMigrationEvent = (msg: TgMessage): string | null => {
    const pinned = pinnedMessageDetail(msg);
    if (pinned !== null) return pinned;
    if (msg.migrate_to_chat_id !== undefined) return 'the group was migrated to a supergroup';
    if (msg.migrate_from_chat_id !== undefined) return 'this message is from the old group before the migration';
    if (msg.group_chat_created) return 'the group was created';
    if (msg.supergroup_chat_created) return 'the supergroup was created';
    if (msg.channel_chat_created) return 'the channel was created';
    return null;
};

const describeForumEvent = (msg: TgMessage): string | null => {
    const created = msg.forum_topic_created;
    if (created !== undefined) return `created the topic "${collapseOneLine(created.name)}"`;
    const edited = msg.forum_topic_edited;
    if (edited !== undefined) {
        return edited.name === undefined
            ? 'changed the topic icon'
            : `renamed the topic to "${collapseOneLine(edited.name)}"`;
    }
    if (msg.forum_topic_closed !== undefined) return 'closed a forum topic';
    if (msg.forum_topic_reopened !== undefined) return 'reopened a forum topic';
    if (msg.general_forum_topic_hidden !== undefined) return 'hid the General topic';
    if (msg.general_forum_topic_unhidden !== undefined) return 'showed the General topic';
    return null;
};

const describeVideoChatEvent = (msg: TgMessage): string | null => {
    if (msg.video_chat_started !== undefined) return 'started a video chat';
    const ended = msg.video_chat_ended;
    if (ended !== undefined) return `ended the video chat (${durationOf(ended.duration)})`;
    const scheduled = msg.video_chat_scheduled;
    if (scheduled !== undefined) return `scheduled a video chat for ${utcOf(scheduled.start_date)}`;
    const invited = msg.video_chat_participants_invited;
    if (invited !== undefined) {
        const count = invited.users.length;
        return `invited ${count} ${count === 1 ? 'person' : 'people'} to a video chat`;
    }
    return null;
};

const describeModerationEvent = (msg: TgMessage): string | null => {
    const timer = msg.message_auto_delete_timer_changed;
    if (timer !== undefined) {
        return timer.message_auto_delete_time === 0
            ? 'turned off the auto-delete timer'
            : `set messages to auto-delete after ${durationOf(timer.message_auto_delete_time)}`;
    }
    const boost = msg.boost_added;
    if (boost !== undefined) {
        const count = boost.boost_count;
        return `boosted the group (${count} ${count === 1 ? 'boost' : 'boosts'})`;
    }
    const proximity = msg.proximity_alert_triggered;
    if (proximity !== undefined) return `triggered a proximity alert for ${userNameOf(proximity.watcher)}`;
    return null;
};

const giveawayPrizeOf = (giveaway: Giveaway): string | null => {
    if (giveaway.prize_description !== undefined) {
        return `"${collapseOneLine(giveaway.prize_description)}"`;
    }
    if (giveaway.prize_star_count !== undefined) return `${giveaway.prize_star_count} stars`;
    if (giveaway.premium_subscription_month_count !== undefined) {
        return `${giveaway.premium_subscription_month_count}-month Premium`;
    }
    return null;
};

const describeGiveawayEvent = (msg: TgMessage): string | null => {
    const running = msg.giveaway;
    if (running !== undefined) {
        const prize = giveawayPrizeOf(running);
        const prizeNote = prize === null ? '' : `, prize ${prize}`;
        return `a giveaway is running: ${running.winner_count} winners${prizeNote}`;
    }
    if (msg.giveaway_created !== undefined) {
        const prize = msg.giveaway_created.prize_star_count;
        return prize === undefined ? 'scheduled a giveaway' : `scheduled a giveaway (prize: ${prize} stars)`;
    }
    const winners = msg.giveaway_winners;
    if (winners !== undefined) return `giveaway ended: ${winners.winner_count} winners`;
    const completed = msg.giveaway_completed;
    if (completed !== undefined) return `giveaway completed: ${completed.winner_count} winners`;
    return null;
};

const describeGiftEvent = (msg: TgMessage): string | null => {
    const gift = msg.gift;
    if (gift !== undefined) return `sent a gift (${gift.gift.star_count} stars)`;
    const uniqueGift = msg.unique_gift;
    if (uniqueGift !== undefined) return `sent a unique gift "${collapseOneLine(uniqueGift.gift.name)}"`;
    const upgrade = msg.gift_upgrade_sent;
    if (upgrade !== undefined) {
        // The upgrade's unique name only rides UniqueGiftInfo; GiftInfo has the
        // regular gift and its star price
        return `upgraded a gift (${upgrade.gift.star_count} stars)`;
    }
    return null;
};

const describeChecklistChangeEvent = (msg: TgMessage): string | null => {
    const done = msg.checklist_tasks_done;
    if (done !== undefined) {
        const markedDone = done.marked_as_done_task_ids?.length ?? 0;
        const markedNotDone = done.marked_as_not_done_task_ids?.length ?? 0;
        if (markedDone > 0 && markedNotDone > 0) {
            return `marked ${markedDone} checklist tasks as done and ${markedNotDone} as not done`;
        }
        if (markedDone > 0) return `marked ${markedDone} checklist ${markedDone === 1 ? 'task' : 'tasks'} as done`;
        if (markedNotDone > 0) {
            return `marked ${markedNotDone} checklist ${markedNotDone === 1 ? 'task' : 'tasks'} as not done`;
        }
        return 'changed the checklist tasks';
    }
    const added = msg.checklist_tasks_added;
    if (added !== undefined) {
        const tasks: ChecklistTask[] = added.tasks;
        if (tasks.length === 1 && tasks[0] !== undefined) {
            return `added a task "${collapseOneLine(tasks[0].text)}" to a checklist`;
        }
        return `added ${tasks.length} tasks to a checklist`;
    }
    return null;
};

const describeShareEvent = (msg: TgMessage): string | null => {
    const users = msg.users_shared;
    if (users !== undefined) {
        const count = users.users.length;
        return `shared ${count} ${count === 1 ? 'user' : 'users'} with the bot`;
    }
    const chat = msg.chat_shared;
    if (chat !== undefined) {
        return chat.title === undefined
            ? 'shared a chat with the bot'
            : `shared the chat "${collapseOneLine(chat.title)}" with the bot`;
    }
    if (msg.web_app_data !== undefined) return 'a Web App sent data';
    return null;
};

const describeLoginAndPaymentEvent = (msg: TgMessage): string | null => {
    if (msg.connected_website !== undefined) {
        return `logged in to ${collapseOneLine(msg.connected_website)} via Telegram`;
    }
    if (msg.write_access_allowed !== undefined) return 'allowed the bot to write messages';
    const payment = msg.successful_payment;
    if (payment !== undefined) {
        return `payment received: ${moneyOf(payment.currency, payment.total_amount)}`;
    }
    const refund = msg.refunded_payment;
    if (refund !== undefined) return `payment refunded: ${moneyOf(refund.currency, refund.total_amount)}`;
    if (msg.passport_data !== undefined) return 'Telegram Passport data was shared';
    return null;
};

const describeOwnerAndCommunityEvent = (msg: TgMessage): string | null => {
    const ownerLeft = msg.chat_owner_left;
    if (ownerLeft !== undefined) {
        const next = ownerLeft.new_owner;
        return next === undefined ? 'the group owner left' : `the group owner left; ${userNameOf(next)} takes over`;
    }
    const ownerChanged = msg.chat_owner_changed;
    if (ownerChanged !== undefined) {
        return `the group owner changed to ${userNameOf(ownerChanged.new_owner)}`;
    }
    const added = msg.community_chat_added;
    if (added !== undefined) return `the chat was added to the community "${collapseOneLine(added.community.name)}"`;
    const joined = msg.community_chat_joined;
    if (joined !== undefined) return `the chat joined the community "${collapseOneLine(joined.community.name)}"`;
    if (msg.community_chat_removed !== undefined) return 'the chat was removed from its community';
    const managedBot = msg.managed_bot_created;
    if (managedBot !== undefined) {
        return managedBot.bot.username === undefined
            ? 'created a bot managed by this bot'
            : `created a bot managed by this bot (@${managedBot.bot.username})`;
    }
    return null;
};

const describePriceAndPollEvent = (msg: TgMessage): string | null => {
    const directPrice = msg.direct_message_price_changed;
    if (directPrice !== undefined) {
        return directPrice.are_direct_messages_enabled
            ? 'enabled paid direct messages'
            : 'changed the direct message price';
    }
    const paidPrice = msg.paid_message_price_changed;
    if (paidPrice !== undefined) {
        return `changed the paid message price to ${paidPrice.paid_message_star_count} stars`;
    }
    // Bot API 10.5 field: absent from @grammyjs/types 5.0.0
    if ('paid_messages_waived' in msg) return 'waived the paid message price';
    const optionAdded = msg.poll_option_added;
    if (optionAdded !== undefined) {
        return `added the poll option "${collapseOneLine(optionAdded.option_text)}"`;
    }
    const optionDeleted = msg.poll_option_deleted;
    if (optionDeleted !== undefined) {
        return `deleted the poll option "${collapseOneLine(optionDeleted.option_text)}"`;
    }
    return null;
};

const describeSuggestedPostEvent = (msg: TgMessage): string | null => {
    if (msg.suggested_post_approved !== undefined) return 'a suggested post was approved';
    if (msg.suggested_post_approval_failed !== undefined) return 'a suggested post could not be approved';
    if (msg.suggested_post_declined !== undefined) return 'a suggested post was declined';
    if (msg.suggested_post_paid !== undefined) return 'a suggested post was paid';
    if (msg.suggested_post_refunded !== undefined) return 'a suggested post payment was refunded';
    return null;
};

/** Service events: group activity that is not user content, rendered as [service: …] */
const describeServiceDetail = (msg: TgMessage): string | null =>
    describeMemberEvent(msg)
    ?? describeChatProfileEvent(msg)
    ?? describePinAndMigrationEvent(msg)
    ?? describeForumEvent(msg)
    ?? describeVideoChatEvent(msg)
    ?? describeModerationEvent(msg)
    ?? describeGiveawayEvent(msg)
    ?? describeGiftEvent(msg)
    ?? describeChecklistChangeEvent(msg)
    ?? describeShareEvent(msg)
    ?? describeLoginAndPaymentEvent(msg)
    ?? describeOwnerAndCommunityEvent(msg)
    ?? describePriceAndPollEvent(msg)
    ?? describeSuggestedPostEvent(msg)
    // Bot API 10.4 TON transfer: absent from @grammyjs/types 5.0.0
    ?? ('ton_wallet_transfer' in msg ? 'TON wallet transfer' : null);

const NON_EMPTY_TEXT = (text: string | undefined): boolean =>
    text !== undefined && text.trim() !== '';

/**
 * Bot API Message fields this build knows about (content, service and plain
 * metadata). Reaching a message with none of them and no text/media/known type
 * means Telegram added a field we do not handle yet: the type goes into the
 * detail so a later reader can identify it.
 */
const KNOWN_MESSAGE_FIELDS: ReadonlySet<string> = new Set([
    // Envelope and metadata
    'message_id', 'message_thread_id', 'direct_messages_topic', 'from', 'sender_chat',
    'sender_boost_count', 'sender_business_bot', 'sender_tag', 'receiver_user',
    'ephemeral_message_id', 'date', 'guest_query_id', 'business_connection_id', 'chat',
    'forward_origin', 'is_topic_message', 'is_automatic_forward', 'reply_to_message',
    'external_reply', 'quote', 'reply_to_story', 'reply_to_checklist_task_id',
    'reply_to_poll_option_id', 'via_bot', 'guest_bot_caller_user', 'guest_bot_caller_chat',
    'edit_date', 'has_protected_content', 'is_from_offline', 'is_paid_post', 'media_group_id',
    'author_signature', 'paid_star_count', 'link_preview_options', 'effect_id', 'reply_markup',
    'show_caption_above_media', 'has_media_spoiler',
    // Text and ordinary media
    'text', 'entities', 'rich_message', 'animation', 'audio', 'document', 'live_photo',
    'paid_media', 'photo', 'sticker', 'story', 'video', 'video_note', 'voice', 'widget',
    'caption', 'caption_entities',
    // Content types
    'checklist', 'contact', 'dice', 'game', 'poll', 'venue', 'location',
    // Service events
    'new_chat_members', 'left_chat_member', 'chat_owner_left', 'chat_owner_changed',
    'new_chat_title', 'new_chat_photo', 'delete_chat_photo', 'group_chat_created',
    'supergroup_chat_created', 'channel_chat_created', 'message_auto_delete_timer_changed',
    'migrate_to_chat_id', 'migrate_from_chat_id', 'pinned_message', 'invoice',
    'successful_payment', 'refunded_payment', 'users_shared', 'chat_shared', 'gift',
    'unique_gift', 'gift_upgrade_sent', 'connected_website', 'write_access_allowed',
    'passport_data', 'proximity_alert_triggered', 'boost_added', 'chat_background_set',
    'checklist_tasks_done', 'checklist_tasks_added', 'community_chat_added',
    'community_chat_joined', 'community_chat_removed', 'direct_message_price_changed',
    'forum_topic_created', 'forum_topic_edited', 'forum_topic_closed', 'forum_topic_reopened',
    'general_forum_topic_hidden', 'general_forum_topic_unhidden', 'giveaway_created',
    'giveaway', 'giveaway_winners', 'giveaway_completed', 'managed_bot_created',
    'paid_message_price_changed', 'paid_messages_waived', 'poll_option_added',
    'poll_option_deleted', 'suggested_post_info', 'suggested_post_approved',
    'suggested_post_approval_failed', 'suggested_post_declined', 'suggested_post_paid',
    'suggested_post_refunded', 'ton_wallet_transfer',
]);

/** First field of the update that this build does not know; null for a plain empty message */
const firstUnknownField = (msg: TgMessage): string | null => {
    for (const field of Object.keys(msg)) {
        if (!KNOWN_MESSAGE_FIELDS.has(field)) return field;
    }
    return null;
};

/**
 * What a message is, for storage in `messageKind` / `messageDetail`.
 *
 * - text/media messages return null (their content is already stored as text
 *   and media; the columns stay NULL);
 * - a content or service field returns its kind and a model-readable detail;
 * - a message with no text, no media and no known type is `unsupported`, so the
 *   model reads an explicit annotation instead of an empty block.
 *
 * `/chat` summons are not passed here: their annotation comes from the
 * chatCommand column, and their empty text is expected.
 */
export const describeMessageContent = (
    msg: TgMessage | undefined,
    options: { readonly hasCapturedMedia: boolean }
): MessageContentKind | null => {
    if (msg === undefined) return null;

    const content = describeContentKind(msg);
    if (content !== null) {
        return { kind: content.kind, detail: content.detail === null ? null : sanitizeMessageDetail(content.detail) };
    }

    if (options.hasCapturedMedia) return null;
    if (NON_EMPTY_TEXT(msg.text) || NON_EMPTY_TEXT(msg.caption) || msg.rich_message !== undefined) {
        return null;
    }

    const service = describeServiceDetail(msg);
    if (service !== null) return { kind: 'service', detail: sanitizeMessageDetail(service) };

    const unknownField = firstUnknownField(msg);
    return {
        kind: 'unsupported',
        detail: unknownField === null
            ? null
            : sanitizeMessageDetail(`Bot API field "${unknownField}"`),
    };
};
