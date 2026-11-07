import { match } from 'ts-pattern';
import type { ApiFailure, IssueListResponse, IssueSummary } from '../../../api';
import type { IssueFilters } from './issue-filters';
import type { IssueListData } from './issue-list-snapshots';

export type IssuePageKind = 'first' | 'next';

export interface IssuePageRequest {
    kind: IssuePageKind;
    filters: IssueFilters;
    offset: number;
}

export interface IssueListState {
    // Filters shown in the bar; the rows catch up once the first-page request lands
    filters: IssueFilters;
    // null until a first page has arrived
    data: IssueListData | null;
    // The page in flight; a new object per request, so an answer to a replaced request can be told apart
    request: IssuePageRequest | null;
    failure: { kind: IssuePageKind; failure: ApiFailure } | null;
}

export type IssueListAction =
    | { type: 'filtersChanged'; filters: IssueFilters }
    | { type: 'moreRequested' }
    | { type: 'retried' }
    | { type: 'pageLoaded'; request: IssuePageRequest; response: IssueListResponse }
    | { type: 'pageFailed'; request: IssuePageRequest; failure: ApiFailure };

const firstPageRequest = (filters: IssueFilters): IssuePageRequest => ({ kind: 'first', filters, offset: 0 });

const nextPageRequest = (data: IssueListData): IssuePageRequest | null =>
    data.nextOffset === null ? null : { kind: 'next', filters: data.filters, offset: data.nextOffset };

/** A restored snapshot shows at once without a request; otherwise the first page loads */
export const initialIssueListState = (snapshot: IssueListData | null, defaultFilters: IssueFilters): IssueListState =>
    snapshot === null
        ? { filters: defaultFilters, data: null, request: firstPageRequest(defaultFilters), failure: null }
        : { filters: snapshot.filters, data: snapshot, request: null, failure: null };

/** The next page appended; a row that moved up between the two requests is not shown twice */
const appendPage = (rows: readonly IssueSummary[], page: readonly IssueSummary[]): IssueSummary[] => {
    const shownIds = new Set(rows.map((row) => row.id));
    return [...rows, ...page.filter((row) => !shownIds.has(row.id))];
};

const loadedData = (state: IssueListState, request: IssuePageRequest, response: IssueListResponse): IssueListData => ({
    filters: request.filters,
    issues:
        request.kind === 'next' && state.data !== null ? appendPage(state.data.issues, response.issues) : response.issues,
    nextOffset: response.nextOffset,
    matched: response.matched,
    stats: response.stats,
});

/** Retries what failed: the next page while the rows stand, otherwise the first page of the current filters */
const retryRequest = (state: IssueListState): IssuePageRequest => {
    const failedNextPage = state.failure?.kind === 'next' && state.data !== null ? nextPageRequest(state.data) : null;
    return failedNextPage ?? firstPageRequest(state.filters);
};

export const issueListReducer = (state: IssueListState, action: IssueListAction): IssueListState =>
    match(action)
        .returnType<IssueListState>()
        // A filter change replaces whatever is in flight
        .with({ type: 'filtersChanged' }, ({ filters }) => ({
            ...state,
            filters,
            request: firstPageRequest(filters),
            failure: null,
        }))
        .with({ type: 'moreRequested' }, () => {
            const request = state.request === null && state.data !== null ? nextPageRequest(state.data) : null;
            return request === null ? state : { ...state, request, failure: null };
        })
        .with({ type: 'retried' }, () =>
            state.request === null ? { ...state, request: retryRequest(state), failure: null } : state
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
