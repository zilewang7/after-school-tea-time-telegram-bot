// Path builders, so the shape of each route lives in one place.

export const HOME_PATH = '/';
export const GLOBAL_SETTINGS_PATH = '/settings';
export const GLOBAL_AUDIT_PATH = '/settings/audit';

/** The owner's read-only model catalog page (under the owner-only settings tab) */
export const GLOBAL_MODEL_CATALOG_PATH = '/settings/model-catalog';

/** The clipboard converter home tab: markdown ⇄ Telegram entities */
export const TOOLS_PATH = '/tools';

/** The access home tab: the owner's review list, or a trial user's application */
export const ACCESS_PATH = '/access';

/** One access application's review page (owner only) */
export const accessApplicationPath = (applicationId: number): string => `${ACCESS_PATH}/${applicationId}`;

/** Where a startapp reply link lands when the requester cannot see the reply */
export const NO_ACCESS_PATH = '/no-access';

/** A home tab; '' is the chat list at "/" */
export const homeTabPath = (tabPath: string): string => (tabPath === '' ? HOME_PATH : `/${tabPath}`);

/** The chat layer's root; it redirects to the remembered or default tab */
export const chatPath = (chatId: number): string => `/c/${chatId}`;

export const chatTabPath = (chatId: number, tabPath: string): string => `/c/${chatId}/${tabPath}`;

export const chatSettingsToolsPath = (chatId: number): string => `/c/${chatId}/settings/tools`;

export const chatSettingsAuditPath = (chatId: number): string => `/c/${chatId}/settings/audit`;

/** The conversation list tab (the chat's default tab) */
export const chatConversationsPath = (chatId: number): string => chatTabPath(chatId, 'conv');

/** One conversation's tree and model view */
export const conversationPath = (chatId: number, rootId: number): string => `/c/${chatId}/conv/${rootId}`;

/** One bot reply's detail (versions and metrics) */
export const replyPath = (chatId: number, firstMessageId: number): string =>
    `/c/${chatId}/replies/${firstMessageId}`;

/** Query marker: the reply page scrolls its widget card into view */
export const FOCUS_WIDGET_PARAM = 'focus';
export const FOCUS_WIDGET_VALUE = 'widget';

/** The reply page of a share that has a widget: land on the card, not the top of the reply */
export const replyWidgetFocusPath = (chatId: number, firstMessageId: number): string =>
    `${replyPath(chatId, firstMessageId)}?${FOCUS_WIDGET_PARAM}=${FOCUS_WIDGET_VALUE}`;

/**
 * A share's read-only page; the token is the permission, so it opens for
 * someone who is not in the chat (or not a member of the panel's chats at all).
 */
export const sharePath = (token: string): string => `/share/${encodeURIComponent(token)}`;

/**
 * A thinking link's public Mini App page; same token-as-permission model as a
 * share, so it also opens outside the panel.
 */
export const thinkingPath = (token: string): string => `/think/${encodeURIComponent(token)}`;

/** The thinking link's fast SSR page (no Telegram needed), same origin as the panel */
export const thinkingFastPagePath = (token: string): string => `/t/${encodeURIComponent(token)}`;

/** An issue's detail page; it lives outside the chat layer because an issue may belong to no chat */
export const issuePath = (issueId: number): string => `/issues/${issueId}`;

/** The chat picker in front of the chat-scoped new-issue form */
export const ISSUE_NEW_CHAT_PICKER_PATH = '/issues/new';

/** The new-issue form of a chat */
export const chatIssueNewPath = (chatId: number): string => `/c/${chatId}/issues/new`;

/** Pathname split into its non-empty segments: "/c/1/settings" -> ["c", "1", "settings"] */
export const pathSegmentsOf = (pathname: string): string[] =>
    pathname.split('/').filter((segment) => segment !== '');
