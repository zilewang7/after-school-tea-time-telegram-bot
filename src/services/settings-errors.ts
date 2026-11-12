/**
 * What the chat and global settings writes share: who writes, and how a
 * refused write is reported (the panel maps the code one to one).
 */
import type { ChatSettingsErrorCode } from './chat-settings-rules.js';

export interface SettingsActor {
    userId: number;
    isOwner: boolean;
}

export class ChatSettingsError extends Error {
    readonly code: ChatSettingsErrorCode;

    constructor(code: ChatSettingsErrorCode, message: string) {
        super(message);
        this.name = 'ChatSettingsError';
        this.code = code;
    }
}
