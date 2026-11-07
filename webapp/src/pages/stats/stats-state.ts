import { match } from 'ts-pattern';
import type { ApiFailure, StatsRangeKey, StatsResponse } from '../../api';

export interface StatsRequest {
    chatId: number | null;
    range: StatsRangeKey;
}

export interface StatsState {
    // null = every chat (owner only)
    chatId: number | null;
    range: StatsRangeKey;
    // The last answer; kept while another range loads, so charts dim instead of flashing
    data: StatsResponse | null;
    // The request in flight; a new object per request
    request: StatsRequest | null;
    failure: ApiFailure | null;
}

export type StatsAction =
    | { type: 'rangeChanged'; range: StatsRangeKey }
    | { type: 'retried' }
    | { type: 'loaded'; request: StatsRequest; response: StatsResponse }
    | { type: 'failed'; request: StatsRequest; failure: ApiFailure };

export const initialStatsState = (chatId: number | null, range: StatsRangeKey): StatsState => ({
    chatId,
    range,
    data: null,
    request: { chatId, range },
    failure: null,
});

const requestOf = (state: StatsState): StatsRequest => ({ chatId: state.chatId, range: state.range });

export const statsReducer = (state: StatsState, action: StatsAction): StatsState =>
    match(action)
        .returnType<StatsState>()
        .with({ type: 'rangeChanged' }, ({ range }) =>
            state.range === range ? state : { ...state, range, request: requestOf({ ...state, range }), failure: null }
        )
        .with({ type: 'retried' }, () =>
            state.request === null ? { ...state, request: requestOf(state), failure: null } : state
        )
        // Answers to a request that was replaced meanwhile are dropped
        .with({ type: 'loaded' }, ({ request, response }) =>
            state.request === request ? { ...state, data: response, request: null, failure: null } : state
        )
        .with({ type: 'failed' }, ({ request, failure }) =>
            state.request === request ? { ...state, request: null, failure } : state
        )
        .exhaustive();
