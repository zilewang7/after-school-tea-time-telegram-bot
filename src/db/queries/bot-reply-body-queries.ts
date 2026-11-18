/**
 * Where a bot reply's `#N` context number opens.
 *
 * A reply is stored under its first message id, which is also the id a context
 * numbers it by. That first message is not always the answer: a reply whose
 * chain of thought is long leads with the link message that hides the CoT
 * (design 2026-1111-1327), and that message carries a link only. The number
 * must open the message the body starts in, so the layout is read here.
 *
 * The current version is the only place the layout is recorded. A version
 * switch lays the same version out again under new message ids and rewrites
 * them, so this read follows it; links already rendered before the switch keep
 * pointing at the ids they were rendered with.
 *
 * The `versions` column is a JSON column that the model writes a JSON string
 * into, so the stored text is encoded twice: the outer json_extract unwraps the
 * model's string, the inner one reads the current version. Extracting in SQL
 * keeps the base64 media a version carries (megabytes on an image reply) out of
 * the process — only the layout fields travel.
 */
import { QueryTypes } from '@sequelize/core';
import { sequelize } from '../config.js';

/** One reply's layout: its first message id and the current version's fields */
interface VersionLayout {
    readonly messageId: number;
    /** The version's own first message id; null without a stored version */
    readonly firstMessageId: number | null;
    /** Its second message, where the body starts when the first is the CoT link */
    readonly secondMessageId: number | null;
    /** The version shows the CoT as a link message, so its first message has no body */
    readonly thinkingLinkToken: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const numberOf = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const stringOf = (value: unknown): string | null =>
    typeof value === 'string' && value !== '' ? value : null;

/** The layout fields of one raw row; anything malformed is dropped rather than trusted */
const layoutOf = (raw: unknown): VersionLayout | null => {
    if (!isRecord(raw)) return null;
    const messageId = numberOf(raw.messageId);
    if (messageId === null) return null;
    let fields: unknown;
    try {
        fields = typeof raw.layout === 'string' ? JSON.parse(raw.layout) : undefined;
    } catch {
        return null;
    }
    const [firstMessageId, secondMessageId, thinkingLinkToken] = Array.isArray(fields) ? fields : [];
    return {
        messageId,
        firstMessageId: numberOf(firstMessageId),
        secondMessageId: numberOf(secondMessageId),
        thinkingLinkToken: stringOf(thinkingLinkToken),
    };
};

/**
 * A reply's body starts here: the second message of a version that leads with
 * the CoT link, otherwise its first. A version with no message ids recorded
 * (still streaming) or a reply with no stored version is absent from the map.
 */
const bodyMessageIdOf = (layout: VersionLayout): number | null =>
    layout.thinkingLinkToken !== null && layout.secondMessageId !== null
        ? layout.secondMessageId
        : layout.firstMessageId;

/**
 * The message carrying the body of each reply, keyed by the reply's first
 * message id. Callers use it as the target of the reply's `#N` jump link and
 * keep their own id for replies the map does not name.
 */
export const findBotReplyBodyMessageIds = async (
    chatId: number,
    firstMessageIds: readonly number[]
): Promise<Map<number, number>> => {
    const bodyMessageIds = new Map<number, number>();
    const ids = [...new Set(firstMessageIds)].filter(
        (messageId) => Number.isSafeInteger(messageId) && messageId > 0
    );
    if (ids.length === 0) return bodyMessageIds;

    // The ids are validated integers, so the list cannot carry SQL. Replacements
    // cannot expand to a list here (SQLite has no array binding).
    //
    // The three fields come back as one JSON array: json_extract parses the
    // document once for all of its paths, and a version's base64 media makes a
    // parse expensive enough to matter (a few milliseconds on an image reply).
    const rows: unknown[] = await sequelize.query(
        `SELECT \`messageId\`,
                json_extract(json_extract(\`versions\`, '$'),
                     '$[' || \`currentVersionIndex\` || '].messageIds[0]',
                     '$[' || \`currentVersionIndex\` || '].messageIds[1]',
                     '$[' || \`currentVersionIndex\` || '].thinkingLinkToken') AS \`layout\`
           FROM \`bot_responses\`
          WHERE \`chatId\` = :chatId AND \`messageId\` IN (${ids.join(', ')})`,
        { replacements: { chatId }, type: QueryTypes.SELECT }
    );

    for (const raw of rows) {
        const layout = layoutOf(raw);
        if (layout === null) continue;
        const bodyMessageId = bodyMessageIdOf(layout);
        if (bodyMessageId !== null) bodyMessageIds.set(layout.messageId, bodyMessageId);
    }
    return bodyMessageIds;
};
