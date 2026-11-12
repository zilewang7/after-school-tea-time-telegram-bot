/**
 * Settings writes run one at a time per scope (a chat, or the global scope),
 * so two concurrent writes never compute against the same stale snapshot.
 */
import { isChatSettingsCacheLoaded, loadChatSettingsCache } from './chat-settings-cache.js';

/** Tail of the write queue per scope */
const writeQueues = new Map<string, Promise<unknown>>();

/** Run `task` after every earlier task of the same scope has settled */
export const runSerialized = <T>(scope: string, task: () => Promise<T>): Promise<T> => {
    const previous = writeQueues.get(scope) ?? Promise.resolve();
    const current = previous.then(task, task);
    const tail = current.catch(() => undefined);
    writeQueues.set(scope, tail);
    void tail.then(() => {
        if (writeQueues.get(scope) === tail) writeQueues.delete(scope);
    });
    return current;
};

/** Writes before startup's load (a script, a test) still diff against the database */
export const ensureCacheLoaded = async (): Promise<void> => {
    if (!isChatSettingsCacheLoaded()) await loadChatSettingsCache();
};
