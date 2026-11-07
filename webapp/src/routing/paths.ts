// Path builders, so the shape of each route lives in one place.

export const HOME_PATH = '/';
export const GLOBAL_SETTINGS_PATH = '/settings';
export const GLOBAL_AUDIT_PATH = '/settings/audit';

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


/** An issue's detail page; it lives outside the chat layer because an issue may belong to no chat */
export const issuePath = (issueId: number): string => `/issues/${issueId}`;

/** The new-issue form of a chat */
export const chatIssueNewPath = (chatId: number): string => `/c/${chatId}/issues/new`;

/** Pathname split into its non-empty segments: "/c/1/settings" -> ["c", "1", "settings"] */
export const pathSegmentsOf = (pathname: string): string[] =>
    pathname.split('/').filter((segment) => segment !== '');
