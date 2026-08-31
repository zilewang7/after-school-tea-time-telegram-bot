import { sequelize, enableWriteAheadLog } from "./config.js";
import { Message } from "./messageDTO.js";
import { BotResponse, ButtonState, type ResponseVersion, type ResponseMetadata, type CommandType } from "./botResponseDTO.js";
import { MediaCache } from "./mediaCacheDTO.js";
import { LinkPreviewCache } from "./linkPreviewCacheDTO.js";
import { MessageLink } from "./messageLinkDTO.js";
import { TelegramUser } from "./telegramUserDTO.js";
import { getBlob } from "../util.js";
import { removeAsyncFileSaveMsgId, findFirstMessageIdByContinuation } from '../state.js';

// sync database (the imports above ensure every table is registered before sync)
// Exported so callers can await schema readiness instead of racing the migration;
// the attached catch also keeps a failed sync from becoming an unhandled rejection.
// WAL goes first: the sync itself is a long writer, and it is what a restart
// races against.
export const dbReady = enableWriteAheadLog().then(() => sequelize.sync({ alter: true }));
dbReady.catch((error: unknown) => {
    console.error('[db] schema sync failed:', error);
});

const saveMessage = async (
    info: {
        chatId: number,
        messageId: number,
        userId: number,
        date: Date,
        userName?: string,
        message?: string,
        quoteText?: string,
        fileLink?: string,
        fileBuffer?: Buffer,
        fileMime?: string,
        fileUniqueId?: string,
        replyToId?: number,
        modelParts?: any,
        mediaHint?: string | null,
        forwardOrigin?: string | null,
        viaBot?: string | null,
        /** Serialized `/chat` parameters when this message is a `/chat` summon */
        chatCommand?: string | null
    }
) => {
    const { chatId, messageId, userId, date = new Date(), userName = '佚名', message, quoteText, fileLink, fileBuffer, fileMime, fileUniqueId, replyToId, modelParts, mediaHint, forwardOrigin, viaBot, chatCommand } = info;

    const fromBotSelf = userId === Number(process.env.BOT_USER_ID);
    // Callers pass Number(env) shapes that can be NaN; never write that
    const authorId = Number.isFinite(userId) ? userId : null;

    // async file save
    const saveFile = async (fileLink: string) => {
        try {
            const blob = await getBlob(fileLink);
            const fileBuffer = blob ? Buffer.from(await blob.arrayBuffer()) : undefined;

            if (fileBuffer) {
                const message = await Message.findOne({ where: { chatId, messageId } });
                if (message) {
                    message.file = fileBuffer;
                    if (fileMime !== undefined) {
                        message.fileMime = fileMime;
                    }
                    await message.save();
                }
            }

        } catch (error) {
            console.error("保存文件失败", error);
        } finally {
            removeAsyncFileSaveMsgId(messageId);
        }
    };

    const existingMessage = await Message.findOne({ where: { chatId, messageId } });
    if (existingMessage) {
        existingMessage.text = message ?? existingMessage.text;
        existingMessage.userId = authorId;
        existingMessage.date = date;
        existingMessage.quoteText = quoteText ?? existingMessage.quoteText;
        if (modelParts !== undefined) {
            existingMessage.modelParts = modelParts;
        }
        if (fileUniqueId !== undefined) {
            existingMessage.fileUniqueId = fileUniqueId;
        }
        if (mediaHint !== undefined) {
            existingMessage.mediaHint = mediaHint;
        }
        if (forwardOrigin !== undefined) {
            existingMessage.forwardOrigin = forwardOrigin;
        }
        if (viaBot !== undefined) {
            existingMessage.viaBot = viaBot;
        }
        if (chatCommand !== undefined) {
            existingMessage.chatCommand = chatCommand;
        }

        if (fileBuffer) {
            existingMessage.file = fileBuffer;
            if (fileMime !== undefined) {
                existingMessage.fileMime = fileMime;
            }
            await existingMessage.save();
            return;
        }

        await existingMessage.save();

        if (fileLink) {
            saveFile(fileLink);
        }

        return;
    }

    // No back-reference is written onto the parent: the reply tree is walked by
    // reverse lookup on replyToId (see findReplyChildIds), and the bystanders
    // /chat pulls in are rows in message_links owned by the /chat message. The
    // old `replies` append was an unsynchronized read-modify-write that raced
    // with /chat and silently dropped messages, and dropped them outright when
    // the parent row did not exist yet (a reply arriving mid-stream).
    await Message.create({
        chatId,
        messageId,
        fromBotSelf,
        userId: authorId,
        text: message,
        quoteText,
        date,
        userName,
        file: fileBuffer,
        fileMime: fileMime ?? null,
        fileUniqueId: fileUniqueId ?? null,
        replyToId,
        chatCommand: chatCommand ?? null,
        modelParts: modelParts ?? null,
        mediaHint: mediaHint ?? null,
        forwardOrigin: forwardOrigin ?? null,
        viaBot: viaBot ?? null,
    });

    if (fileLink && !fileBuffer) {
        saveFile(fileLink);
    }
}

const getMessage = async (chatId: number, messageId: number) => {
    const message = await Message.findOne({ where: { chatId, messageId } });
    return message;
}

/**
 * Get a bot response by its first message ID
 */
const getBotResponse = async (chatId: number, messageId: number): Promise<BotResponse | null> => {
    return BotResponse.findOne({ where: { chatId, messageId } });
};

/**
 * Find a bot response by any of its message IDs (searches through all versions)
 */
const findBotResponseByMessageId = async (chatId: number, messageId: number): Promise<BotResponse | null> => {
    // First try direct lookup
    const direct = await getBotResponse(chatId, messageId);
    if (direct) return direct;

    // Try in-memory continuation registry (for active streaming sessions
    // where continuation message_id hasn't been persisted to versions yet)
    const firstId = findFirstMessageIdByContinuation(chatId, messageId);
    if (firstId !== undefined) {
        const fromRegistry = await getBotResponse(chatId, firstId);
        if (fromRegistry) return fromRegistry;
    }

    // Otherwise search through all responses in this chat
    const allResponses = await BotResponse.findAll({ where: { chatId } });

    for (const response of allResponses) {
        const versions = response.getVersions();
        for (const version of versions) {
            if (version.messageIds.includes(messageId)) {
                return response;
            }
        }
    }

    return null;
};

/**
 * Create a new bot response record.
 * The same messageId can be inserted twice when one reply gets processed twice
 * (Telegram update re-delivery, or re-entry of the detached setTimeout handler).
 * Idempotency is enforced upstream by tryMarkUserMessageHandling; this upsert is
 * the last-resort guard so a duplicate can't crash the reply flow on the unique
 * constraint.
 */
const createBotResponse = async (
    chatId: number,
    messageId: number,
    userMessageId: number,
    metadata: ResponseMetadata
): Promise<BotResponse> => {
    // Idempotent upsert (INSERT ... ON CONFLICT DO UPDATE): a duplicate trigger
    // for the same messageId updates the row instead of throwing a unique violation.
    const [response] = await BotResponse.upsert({
        messageId,
        chatId,
        userMessageId,
        currentVersionIndex: 0,
        versions: '[]',
        buttonState: ButtonState.PROCESSING,
        metadata: JSON.stringify(metadata),
    });
    return response;
};

/**
 * Update bot response button state
 */
const updateBotResponseButtonState = async (
    chatId: number,
    messageId: number,
    buttonState: ButtonState
): Promise<boolean> => {
    const response = await getBotResponse(chatId, messageId);
    if (!response) return false;

    response.buttonState = buttonState;
    await response.save();
    return true;
};

export {
    saveMessage,
    getMessage,
    getBotResponse,
    findBotResponseByMessageId,
    createBotResponse,
    updateBotResponseButtonState,
    BotResponse,
    MediaCache,
    LinkPreviewCache,
    MessageLink,
    TelegramUser,
    ButtonState,
    type ResponseVersion,
    type ResponseMetadata,
    type CommandType,
}
