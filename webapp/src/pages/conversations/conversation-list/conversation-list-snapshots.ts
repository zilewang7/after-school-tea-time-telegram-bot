import { createSnapshotStore } from '../../../snapshot-store';
import type { ConversationListData } from './conversation-list-state';

const SNAPSHOT_CAPACITY = 20;

// Rows on screen per history entry, so Back returns to them without a request
const conversationListSnapshots = createSnapshotStore<ConversationListData>(SNAPSHOT_CAPACITY);

export const readConversationListSnapshot = (key: string): ConversationListData | null =>
    conversationListSnapshots.read(key);

export const writeConversationListSnapshot = (key: string, data: ConversationListData): void =>
    conversationListSnapshots.write(key, data);
