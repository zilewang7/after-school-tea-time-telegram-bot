/**
 * What the e2e case files share: the case shape, skipping, model switching and
 * the waits on the group read-back.
 */
import {
    BOT_USER_ID,
    BOT_USERNAME,
    clickButton,
    expect,
    hasFinishedStreaming,
    readGroupMessages,
    sendAsUser,
    sleep,
    type DriverMessage,
} from './harness.mts';

export interface E2eCase {
    name: string;
    /** Only with --full */
    full?: boolean;
    /** Only with --tools: client tool loops and real picture generation (slow, paid) */
    tools?: boolean;
    body: () => Promise<void>;
}

/**
 * Bail out of a case without failing the suite. For dependencies that legitimately
 * come and go — the /pic backend runs on a home machine that isn't always on, and
 * a red suite nobody trusts is worse than a case that says it didn't run.
 */
export class SkippedCase extends Error {}

export const skip = (reason: string): never => {
    throw new SkippedCase(reason);
};

/**
 * Poll a bot message until it satisfies the predicate. session.finalize marks
 * the DB final BEFORE the last edit is delivered, so a read right after
 * waitForBotResponse can still see an intermediate render.
 */
export const waitForVisibleMessage = async (
    minId: number,
    messageId: number,
    predicate: (message: DriverMessage) => boolean,
    timeoutMs = 20_000
): Promise<DriverMessage | undefined> => {
    const deadline = Date.now() + timeoutMs;
    let latest: DriverMessage | undefined;
    while (Date.now() < deadline) {
        const visible = await readGroupMessages(minId);
        latest = visible.find((m) => m.sender_id === BOT_USER_ID && m.id === messageId);
        if (latest && predicate(latest)) return latest;
        await sleep(1500);
    }
    return latest;
};

/**
 * Every message of a reply as the group sees it, once none of them shows a
 * status line any more. On timeout: whatever was visible last, so the caller's
 * assertions say what is missing.
 */
export const waitForFinishedReply = async (
    minId: number,
    messageIds: readonly number[],
    timeoutMs = 30_000
): Promise<DriverMessage[]> => {
    const deadline = Date.now() + timeoutMs;
    let latest: DriverMessage[] = [];
    while (Date.now() < deadline) {
        const visible = await readGroupMessages(minId);
        latest = visible.filter((m) => m.sender_id === BOT_USER_ID && messageIds.includes(m.id));
        if (latest.length === messageIds.length && latest.every(hasFinishedStreaming)) return latest;
        await sleep(1500);
    }
    return latest;
};

/** Callback data the model menu uses (see src/cmd/menu.ts) */
const MODEL_CALLBACK_PREFIX = 'mdl:';

/** The model this run last switched the bot to */
let switchedModel: string | undefined;

/**
 * Drive the model switcher the way a user does: `/model`, expand the keyboard,
 * press the model. Returns the menu message id.
 */
export const switchModelWithKeyboard = async (model: string): Promise<number> => {
    const lastId = await latestGroupMessageId();
    await sendAsUser(`/model@${BOT_USERNAME}`);

    const findBotMessage = (contains: string): Promise<DriverMessage | undefined> =>
        findBotMessageAfter(lastId, contains);

    const menu = await findBotMessage('当前模型');
    if (!menu) throw new Error('the model menu never arrived');
    expect(menu.has_buttons, 'the model menu carries its keyboard');

    // Collapsed by default: expand, then press the model itself
    await clickButton(menu.id, `${MODEL_CALLBACK_PREFIX}expand`);
    await sleep(1500);
    await clickButton(menu.id, `${MODEL_CALLBACK_PREFIX}${model}`);

    const switched = await findBotMessage(`切换为`);
    if (!switched) throw new Error('the bot never confirmed the switch');
    expect(
        switched.text.includes(model),
        `the confirmation names ${model} (got: ${switched.text.replace(/\n/g, ' ').slice(0, 80)})`
    );
    switchedModel = model;
    return menu.id;
};

/** Switch unless this run already did: a case picked alone with --only still gets its model */
export const ensureModel = async (model: string): Promise<void> => {
    if (switchedModel !== model) await switchModelWithKeyboard(model);
};

/** Id of the newest message in the test group, 0 when it reads empty */
const latestGroupMessageId = async (): Promise<number> => {
    const before = await readGroupMessages(0, 1);
    return before[before.length - 1]?.id ?? 0;
};

/** The first bot message after `lastId` containing `contains`, polled for ~30s */
const findBotMessageAfter = async (lastId: number, contains: string): Promise<DriverMessage | undefined> => {
    for (let attempt = 0; attempt < 20; attempt++) {
        await sleep(1500);
        const visible = await readGroupMessages(lastId);
        const found = visible.find((m) => m.sender_id === BOT_USER_ID && m.text.includes(contains));
        if (found) return found;
    }
    return undefined;
};

/**
 * Typed `/model <request>`; returns the confirmation text. `default` puts the
 * chat back on the global default. The model is stored per chat now, so it
 * outlives the run unless a run puts it back.
 */
export const setModelByCommand = async (request: string): Promise<string> => {
    const lastId = await latestGroupMessageId();
    await sendAsUser(`/model@${BOT_USERNAME} ${request}`);
    const confirmation = await findBotMessageAfter(lastId, '切换为');
    if (!confirmation) throw new Error(`the bot never confirmed /model ${request}`);
    switchedModel = request === 'default' ? undefined : request;
    return confirmation.text;
};

/** `/model default`: the test group follows the global default again */
export const resetModelToDefault = (): Promise<string> => setModelByCommand('default');
