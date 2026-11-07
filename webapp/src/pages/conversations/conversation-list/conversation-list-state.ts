import { match } from 'ts-pattern';
import type { ApiFailure, ConversationListItem, ConversationListResponse } from '../../../api';

export type ConversationPageKind = 'first' | 'next';

export interface ConversationPageRequest {
    kind: ConversationPageKind;
    // Cursor of the page; null asks for the newest one
    before: string | null;
}

export interface ConversationListData {
    conversations: ConversationListItem[];
    nextBefore: string | null;
}

export interface ConversationListState {
    // null until a first page has arrived
    data: ConversationListData | null;
    // The page in flight; a new object per request, so an answer to a replaced request can be told apart
    request: ConversationPageRequest | null;
    failure: { kind: ConversationPageKind; failure: ApiFailure } | null;
}

export type ConversationListAction =
    | { type: 'moreRequested' }
    | { type: 'retried' }
    | { type: 'reloaded' }
    | { type: 'pageLoaded'; request: ConversationPageRequest; response: ConversationListResponse }
    | { type: 'pageFailed'; request: ConversationPageRequest; failure: ApiFailure };

const FIRST_REQUEST: ConversationPageRequest = { kind: 'first', before: null };

/** A restored snapshot shows at once without a request; otherwise the newest page loads */
export const initialConversationListState = (snapshot: ConversationListData | null): ConversationListState =>
    snapshot === null
        ? { data: null, request: FIRST_REQUEST, failure: null }
        : { data: snapshot, request: null, failure: null };

const nextPageRequest = (data: ConversationListData): ConversationPageRequest | null =>
    data.nextBefore === null ? null : { kind: 'next', before: data.nextBefore };

/** The next page appended; a conversation that moved up between the two requests is not shown twice */
const appendPage = (
    rows: readonly ConversationListItem[],
    page: readonly ConversationListItem[]
): ConversationListItem[] => {
    const shownRootIds = new Set(rows.map((row) => row.rootId));
    return [...rows, ...page.filter((row) => !shownRootIds.has(row.rootId))];
};

const loadedData = (
    state: ConversationListState,
    request: ConversationPageRequest,
    response: ConversationListResponse
): ConversationListData => ({
    conversations:
        request.kind === 'next' && state.data !== null
            ? appendPage(state.data.conversations, response.conversations)
            : response.conversations,
    nextBefore: response.nextBefore,
});

/** Retries what failed: the next page while the rows stand, otherwise the newest page */
const retryRequest = (state: ConversationListState): ConversationPageRequest => {
    const failedNextPage = state.failure?.kind === 'next' && state.data !== null ? nextPageRequest(state.data) : null;
    return failedNextPage ?? FIRST_REQUEST;
};

export const conversationListReducer = (
    state: ConversationListState,
    action: ConversationListAction
): ConversationListState =>
    match(action)
        .returnType<ConversationListState>()
        .with({ type: 'moreRequested' }, () => {
            const request = state.request === null && state.data !== null ? nextPageRequest(state.data) : null;
            return request === null ? state : { ...state, request, failure: null };
        })
        .with({ type: 'retried' }, () =>
            state.request === null ? { ...state, request: retryRequest(state), failure: null } : state
        )
        // A background refresh of the newest page: the rows stay on screen meanwhile
        .with({ type: 'reloaded' }, () =>
            state.request === null ? { ...state, request: FIRST_REQUEST, failure: null } : state
        )
        // Answers to a request that was replaced meanwhile are dropped
        .with({ type: 'pageLoaded' }, ({ request, response }) =>
            state.request === request
                ? { ...state, data: loadedData(state, request, response), request: null, failure: null }
                : state
        )
        .with({ type: 'pageFailed' }, ({ request, failure }) =>
            state.request === request ? { ...state, request: null, failure: { kind: request.kind, failure } } : state
        )
        .exhaustive();
