// Prompt addendum rules shared by the editor and the save logic (mirrors the server's normalization).

import { readStorage, removeStorage, writeStorage } from './storage';

export const ADDENDUM_MAX_CODE_POINTS = 2000;

// Upper-bound estimate used by the server as well: 1.3 tokens per character
const TOKENS_PER_CODE_POINT = 1.3;

/** CRLF -> LF and trim; the server stores an empty result as NULL */
export const normalizeAddendum = (text: string): string => text.replaceAll('\r\n', '\n').trim();

/** The value to store: normalized text, or null when empty */
export const addendumValueOf = (text: string): string | null => {
    const normalized = normalizeAddendum(text);
    return normalized === '' ? null : normalized;
};

export const countCodePoints = (text: string): number => Array.from(text).length;

export const estimateAddendumTokens = (codePoints: number): number => Math.ceil(codePoints * TOKENS_PER_CODE_POINT);

const draftKeyOf = (chatId: number): string => `draft:addendum:${chatId}`;

export interface AddendumStart {
    text: string;
    restoredFromDraft: boolean;
}

/** Initial editor text: an unsaved local draft wins over the saved value */
export const restoreAddendumDraft = (chatId: number, savedValue: string | null): AddendumStart => {
    const savedText = savedValue ?? '';
    const draft = readStorage(draftKeyOf(chatId));
    if (draft === null) return { text: savedText, restoredFromDraft: false };
    if (addendumValueOf(draft) === savedValue) {
        removeStorage(draftKeyOf(chatId));
        return { text: savedText, restoredFromDraft: false };
    }
    return { text: draft, restoredFromDraft: true };
};

/** Stores the draft, or drops it when it matches what is already saved */
export const storeAddendumDraft = (chatId: number, text: string, savedValue: string | null): void => {
    if (addendumValueOf(text) === savedValue) removeStorage(draftKeyOf(chatId));
    else writeStorage(draftKeyOf(chatId), text);
};

export const clearAddendumDraft = (chatId: number): void => removeStorage(draftKeyOf(chatId));
