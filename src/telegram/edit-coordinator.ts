/**
 * Per-chat edit coordinator - desired-state model for Telegram message edits
 *
 * Callers never issue editMessageText directly; they submit the latest desired
 * state of a message. One drain loop per chat flushes dirty messages
 * (desired !== sent) at a budgeted pace, always sending the newest state, so
 * intermediate versions are coalesced away and concurrent streams in the same
 * chat share the budget without thundering-herd bursts.
 *
 * - Priority: final > content > spinner (spinner starves first under load)
 * - 429: reads retry_after and pauses the whole chat; desired states keep
 *   accumulating and the newest one is sent after the penalty
 * - Final states are sticky: retried until delivered (bounded attempts)
 * - Sends (new messages / photos) share the same budget via runApiCall
 */
import { GrammyError } from 'grammy';
import type { Api } from 'grammy';
import type { MessageEntity as RenderedEntity } from 'telegram-md-entities';
import { to } from '../shared/result.js';
import { toApiEntities } from './api-entities.js';

export type EditPriority = 'final' | 'content' | 'spinner';

export interface SubmitEditOptions {
    /** Pre-rendered entities for the text (mutually exclusive with parseMode) */
    entities?: readonly RenderedEntity[];
    /** Server-side parsing, only for hand-written static UI text */
    parseMode?: 'MarkdownV2' | 'HTML' | 'Markdown';
    replyMarkup?: any;
    priority?: EditPriority;
    /** Final state: sticky-retried until delivered, entry removed on success */
    isFinal?: boolean;
    /** Disable link preview for this edit */
    linkPreviewDisabled?: boolean;
}

interface CoordinatorConfig {
    /** Max API calls per window per chat */
    maxCallsPerWindow: number;
    windowMs: number;
    /** First N calls in a window only need the burst interval between them */
    burstCount: number;
    burstIntervalMs: number;
    /** Attempt caps before giving up on a desired state */
    finalMaxAttempts: number;
    transientMaxAttempts: number;
    /** Penalty applied on network errors */
    transientPenaltyMs: number;
    /** Penalty when a 429 does not carry retry_after */
    fallback429PenaltyMs: number;
}

const config: CoordinatorConfig = {
    maxCallsPerWindow: 20,
    windowMs: 60_000,
    burstCount: 10,
    burstIntervalMs: 500,
    finalMaxAttempts: 8,
    transientMaxAttempts: 10,
    transientPenaltyMs: 2_000,
    fallback429PenaltyMs: 30_000,
};

interface DesiredState {
    text: string;
    entities?: readonly RenderedEntity[];
    /** Serialized entities ('[]' when none) for cheap dedup comparison */
    entitiesJson: string;
    parseMode?: 'MarkdownV2' | 'HTML' | 'Markdown';
    replyMarkup?: any;
    replyMarkupJson?: string;
    linkPreviewDisabled?: boolean;
    priority: EditPriority;
    isFinal: boolean;
}

interface MessageEntry {
    messageId: number;
    /** Latest desired state; null when the message is clean */
    desired: DesiredState | null;
    /** Last state successfully sent to Telegram */
    sentText?: string;
    sentEntitiesJson?: string;
    sentMarkupJson?: string;
    /** Flush attempts for the current desired state (reset on new submit) */
    attempts: number;
    submittedAt: number;
    waiters: Array<(delivered: boolean) => void>;
}

interface ChatCoordinator {
    chatId: number | string;
    api: Api | null;
    entries: Map<number, MessageEntry>;
    /** Timestamps of API calls in the current window (attempts count too) */
    callTimestamps: number[];
    lastCallAt: number;
    penaltyUntil: number;
    draining: boolean;
    /** Serializes actual API calls between drain loop and runApiCall */
    callMutex: Promise<void>;
}

const coordinators = new Map<string, ChatCoordinator>();

const priorityRank: Record<EditPriority, number> = {
    final: 0,
    content: 1,
    spinner: 2,
};

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

const getCoordinator = (chatId: number | string): ChatCoordinator => {
    const key = String(chatId);
    let coordinator = coordinators.get(key);
    if (!coordinator) {
        coordinator = {
            chatId,
            api: null,
            entries: new Map(),
            callTimestamps: [],
            lastCallAt: 0,
            penaltyUntil: 0,
            draining: false,
            callMutex: Promise.resolve(),
        };
        coordinators.set(key, coordinator);
    }
    return coordinator;
};

/**
 * Acquire the per-chat API call mutex; returns the release function
 */
const acquireCallSlot = (coordinator: ChatCoordinator): Promise<() => void> => {
    const previous = coordinator.callMutex;
    let release!: () => void;
    coordinator.callMutex = new Promise<void>((resolve) => {
        release = resolve;
    });
    return previous.then(() => release);
};

/**
 * Earliest time the next API call is allowed, honoring window budget and penalty
 */
const nextAllowedAt = (coordinator: ChatCoordinator): number => {
    const now = Date.now();
    const windowStart = now - config.windowMs;
    coordinator.callTimestamps = coordinator.callTimestamps.filter(
        (timestamp) => timestamp > windowStart
    );

    const calls = coordinator.callTimestamps;
    let allowedAt: number;

    if (calls.length < config.burstCount) {
        allowedAt = coordinator.lastCallAt + config.burstIntervalMs;
    } else if (calls.length >= config.maxCallsPerWindow) {
        // Window exhausted: wait until the oldest call leaves the window
        allowedAt = (calls[0] ?? now) + config.windowMs;
    } else {
        // Spread the remaining quota over the remaining window time
        const oldest = calls[0] ?? now;
        const remainingQuota = config.maxCallsPerWindow - calls.length;
        const remainingTime = oldest + config.windowMs - now;
        const spacing = Math.max(config.burstIntervalMs, remainingTime / remainingQuota);
        allowedAt = coordinator.lastCallAt + spacing;
    }

    return Math.max(allowedAt, coordinator.penaltyUntil);
};

/**
 * Sleep until an API call is allowed (penalty may grow while sleeping)
 */
const sleepUntilAllowed = async (coordinator: ChatCoordinator): Promise<void> => {
    for (;;) {
        const wait = nextAllowedAt(coordinator) - Date.now();
        if (wait <= 0) return;
        await sleep(wait);
    }
};

/**
 * Record an API call attempt (failures count too - Telegram counts them)
 */
const recordCall = (coordinator: ChatCoordinator): void => {
    const now = Date.now();
    coordinator.lastCallAt = now;
    coordinator.callTimestamps.push(now);
};

const is429 = (error: unknown): boolean =>
    error instanceof GrammyError && error.error_code === 429;

const getRetryPenaltyMs = (error: unknown): number => {
    if (error instanceof GrammyError) {
        const retryAfter = error.parameters?.retry_after;
        if (typeof retryAfter === 'number') {
            return (retryAfter + 1) * 1000;
        }
    }
    const message = error instanceof Error ? error.message : '';
    const matched = /retry after (\d+)/i.exec(message);
    if (matched?.[1]) {
        return (Number(matched[1]) + 1) * 1000;
    }
    return config.fallback429PenaltyMs;
};

const applyPenalty = (coordinator: ChatCoordinator, penaltyMs: number): void => {
    coordinator.penaltyUntil = Math.max(coordinator.penaltyUntil, Date.now() + penaltyMs);
};

const resolveWaiters = (entry: MessageEntry, delivered: boolean): void => {
    for (const resolve of entry.waiters) {
        resolve(delivered);
    }
    entry.waiters = [];
};

const matchesSentState = (entry: MessageEntry, state: DesiredState): boolean => {
    if (entry.sentText !== state.text) return false;
    // Same text but different entities is still a real change
    if (
        entry.sentEntitiesJson !== undefined &&
        entry.sentEntitiesJson !== state.entitiesJson
    ) {
        return false;
    }
    // Unknown sent markup (e.g. primed state) only compares text
    if (entry.sentMarkupJson === undefined) return true;
    return entry.sentMarkupJson === state.replyMarkupJson;
};

/**
 * Mark a state as delivered; remove the entry when a final state lands
 */
const settleDelivered = (
    coordinator: ChatCoordinator,
    entry: MessageEntry,
    state: DesiredState
): void => {
    entry.sentText = state.text;
    entry.sentEntitiesJson = state.entitiesJson;
    entry.sentMarkupJson = state.replyMarkupJson;
    if (entry.desired === state) {
        entry.desired = null;
        resolveWaiters(entry, true);
        if (state.isFinal) {
            coordinator.entries.delete(entry.messageId);
        }
    }
};

/**
 * Give up on a desired state permanently
 */
const settleFailed = (
    coordinator: ChatCoordinator,
    entry: MessageEntry,
    state: DesiredState
): void => {
    if (entry.desired === state) {
        entry.desired = null;
        resolveWaiters(entry, false);
        if (state.isFinal) {
            coordinator.entries.delete(entry.messageId);
        }
    }
};

const handleEditError = (
    coordinator: ChatCoordinator,
    entry: MessageEntry,
    state: DesiredState,
    error: Error
): void => {
    const message = error.message || '';

    if (message.includes('message is not modified')) {
        settleDelivered(coordinator, entry, state);
        return;
    }

    if (is429(error)) {
        const penaltyMs = getRetryPenaltyMs(error);
        applyPenalty(coordinator, penaltyMs);
        entry.attempts++;
        const cap = state.isFinal ? config.finalMaxAttempts : config.transientMaxAttempts;
        console.warn(
            `[edit-coordinator] 429 on edit (chat ${coordinator.chatId}, msg ${entry.messageId}), ` +
            `backing off ${Math.round(penaltyMs / 1000)}s, attempt ${entry.attempts}/${cap}`
        );
        if (entry.attempts >= cap) {
            console.error('[edit-coordinator] Giving up after repeated 429s');
            settleFailed(coordinator, entry, state);
        }
        // else: entry stays dirty, drain retries the newest state after penalty
        return;
    }

    if (
        error instanceof GrammyError &&
        error.error_code === 400 &&
        state.entities?.length
    ) {
        // Dead-man switch: offline validation should make rejected entities
        // impossible, but if the server refuses them, deliver the plain text
        // over delivering nothing.
        console.error('[edit-coordinator] Edit with entities rejected, degrading to plain text:', message);
        if (entry.desired === state) {
            entry.desired = { ...state, entities: undefined, entitiesJson: '[]' };
            return;
        }
        settleFailed(coordinator, entry, state);
        return;
    }

    if (error instanceof GrammyError) {
        // Other API errors (message not found, can't be edited...) are permanent
        console.error('[edit-coordinator] Edit failed:', message);
        settleFailed(coordinator, entry, state);
        return;
    }

    // Network / unknown errors: transient, retry with a small penalty
    entry.attempts++;
    applyPenalty(coordinator, config.transientPenaltyMs);
    const cap = state.isFinal ? config.finalMaxAttempts : config.transientMaxAttempts;
    console.warn(
        `[edit-coordinator] Edit network error (attempt ${entry.attempts}/${cap}):`,
        message
    );
    if (entry.attempts >= cap) {
        settleFailed(coordinator, entry, state);
    }
};

/**
 * Pick the highest-priority dirty entry (ties: oldest submit first)
 */
const pickNextDirty = (coordinator: ChatCoordinator): MessageEntry | null => {
    let best: MessageEntry | null = null;
    for (const entry of coordinator.entries.values()) {
        if (!entry.desired) continue;
        if (!best || !best.desired) {
            best = entry;
            continue;
        }
        const bestRank = priorityRank[best.desired.priority];
        const rank = priorityRank[entry.desired.priority];
        if (rank < bestRank || (rank === bestRank && entry.submittedAt < best.submittedAt)) {
            best = entry;
        }
    }
    return best;
};

const flushEntry = async (
    coordinator: ChatCoordinator,
    entry: MessageEntry
): Promise<void> => {
    const api = coordinator.api;
    if (!api) {
        // No API captured yet: nothing we can do, drop the state
        const state = entry.desired;
        if (state) settleFailed(coordinator, entry, state);
        return;
    }

    // Dedup without spending budget
    const desired = entry.desired;
    if (!desired) return;
    if (matchesSentState(entry, desired)) {
        settleDelivered(coordinator, entry, desired);
        return;
    }

    const release = await acquireCallSlot(coordinator);
    try {
        await sleepUntilAllowed(coordinator);

        // Re-read after waiting: a newer state may have been submitted
        const state = entry.desired;
        if (!state) return;
        if (matchesSentState(entry, state)) {
            settleDelivered(coordinator, entry, state);
            return;
        }

        recordCall(coordinator);
        const [error] = await to(
            api.editMessageText(coordinator.chatId, entry.messageId, state.text, {
                entities: state.entities?.length
                    ? toApiEntities(state.entities)
                    : undefined,
                parse_mode: state.parseMode,
                reply_markup: state.replyMarkup,
                link_preview_options: state.linkPreviewDisabled
                    ? { is_disabled: true }
                    : undefined,
            })
        );

        if (!error) {
            settleDelivered(coordinator, entry, state);
            return;
        }
        handleEditError(coordinator, entry, state, error);
    } finally {
        release();
    }
};

const ensureDraining = (coordinator: ChatCoordinator): void => {
    if (coordinator.draining) return;
    coordinator.draining = true;

    void (async () => {
        try {
            for (;;) {
                const entry = pickNextDirty(coordinator);
                if (!entry) break;
                await flushEntry(coordinator, entry);
            }
        } catch (error) {
            console.error('[edit-coordinator] Drain loop error:', error);
        } finally {
            coordinator.draining = false;
            // A submit may have raced with loop exit
            if (pickNextDirty(coordinator)) {
                ensureDraining(coordinator);
            }
        }
    })();
};

/**
 * Submit the latest desired state for a message.
 * Resolves true when this state (or a superseding one) is accepted/delivered,
 * false when it is permanently dropped.
 */
export const submitEdit = (
    api: Api,
    chatId: number | string,
    messageId: number,
    text: string,
    options?: SubmitEditOptions
): Promise<boolean> => {
    const coordinator = getCoordinator(chatId);
    coordinator.api = api;

    let entry = coordinator.entries.get(messageId);
    if (!entry) {
        entry = {
            messageId,
            desired: null,
            attempts: 0,
            submittedAt: Date.now(),
            waiters: [],
        };
        coordinator.entries.set(messageId, entry);
    }

    const isFinal = options?.isFinal ?? false;

    // Never let a non-final submit displace a pending final state
    if (entry.desired?.isFinal && !isFinal) {
        return Promise.resolve(false);
    }

    // Superseded states count as accepted: the newest state carries the intent
    if (entry.desired) {
        resolveWaiters(entry, true);
    }
    const entities = options?.entities?.length ? options.entities : undefined;
    const state: DesiredState = {
        text,
        entities,
        entitiesJson: entities ? JSON.stringify(entities) : '[]',
        parseMode: options?.parseMode,
        replyMarkup: options?.replyMarkup,
        replyMarkupJson:
            options?.replyMarkup === undefined
                ? undefined
                : JSON.stringify(options.replyMarkup),
        linkPreviewDisabled: options?.linkPreviewDisabled,
        priority: isFinal ? 'final' : options?.priority ?? 'content',
        isFinal,
    };

    if (matchesSentState(entry, state)) {
        entry.desired = null;
        if (isFinal) {
            coordinator.entries.delete(messageId);
        }
        return Promise.resolve(true);
    }

    entry.desired = state;
    entry.attempts = 0;
    entry.submittedAt = Date.now();

    const promise = new Promise<boolean>((resolve) => {
        entry.waiters.push(resolve);
    });
    ensureDraining(coordinator);
    return promise;
};

/**
 * Seed the "already sent" state so identical submits are skipped
 * (e.g. the initial processing message content)
 */
export const primeSentState = (
    chatId: number | string,
    messageId: number,
    text: string
): void => {
    const coordinator = getCoordinator(chatId);
    let entry = coordinator.entries.get(messageId);
    if (!entry) {
        entry = {
            messageId,
            desired: null,
            attempts: 0,
            submittedAt: Date.now(),
            waiters: [],
        };
        coordinator.entries.set(messageId, entry);
    }
    entry.sentText = text;
    // Primed content is always plain text; an entity-carrying submit with the
    // same text must still be treated as a change
    entry.sentEntitiesJson = '[]';
    entry.sentMarkupJson = undefined;
};

/**
 * Drop a pending non-final desired state (used when a stream stops and a
 * final state is about to be submitted)
 */
export const discardPendingEdit = (
    chatId: number | string,
    messageId: number
): void => {
    const coordinator = coordinators.get(String(chatId));
    const entry = coordinator?.entries.get(messageId);
    if (!entry?.desired || entry.desired.isFinal) return;
    entry.desired = null;
    resolveWaiters(entry, false);
};

/**
 * Remove all coordinator state for a message (used on message deletion)
 */
export const dropMessageState = (
    chatId: number | string,
    messageId: number
): void => {
    const coordinator = coordinators.get(String(chatId));
    const entry = coordinator?.entries.get(messageId);
    if (!entry) return;
    resolveWaiters(entry, false);
    coordinator?.entries.delete(messageId);
};

/**
 * Run a raw API call (sendMessage/sendPhoto/deleteMessage/...) under the same
 * per-chat budget as edits. Flood-wait (429) retries are handled globally by
 * the @grammyjs/auto-retry transformer; if one still escapes it, record the
 * penalty so subsequent calls in this chat pace down, then rethrow.
 */
export const runApiCall = async <T>(
    chatId: number | string,
    apiCall: () => Promise<T>
): Promise<T> => {
    const coordinator = getCoordinator(chatId);
    const release = await acquireCallSlot(coordinator);
    try {
        await sleepUntilAllowed(coordinator);
        recordCall(coordinator);
        return await apiCall();
    } catch (error) {
        if (is429(error)) {
            const penaltyMs = getRetryPenaltyMs(error);
            applyPenalty(coordinator, penaltyMs);
            console.warn(
                `[edit-coordinator] 429 escaped auto-retry (chat ${chatId}), ` +
                `pacing down ${Math.round(penaltyMs / 1000)}s`
            );
        }
        throw error;
    } finally {
        release();
    }
};
