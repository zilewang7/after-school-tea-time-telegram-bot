import { sequelize } from "./config";
import { Message } from "./messageDTO";
import { BotResponse, ButtonState, type ResponseVersion, type ResponseMetadata, type CommandType } from "./botResponseDTO";
import { getBlob } from "../util";
import { removeAsyncFileSaveMsgId } from '../state';

// sync database
sequelize.sync({ alter: true });

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
        replyToId?: number,
        modelParts?: any
    }
) => {
    const { chatId, messageId, userId, date = new Date(), userName = '佚名', message, quoteText, fileLink, fileBuffer, replyToId, modelParts } = info;

    const fromBotSelf = userId === Number(process.env.BOT_USER_ID);

    // async file save
    const saveFile = async (fileLink: string) => {
        try {
            const blob = await getBlob(fileLink);
            const fileBuffer = blob ? Buffer.from(await blob.arrayBuffer()) : undefined;

            if (fileBuffer) {
                const message = await Message.findOne({ where: { chatId, messageId } });
                if (message) {
                    message.file = fileBuffer;
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
        existingMessage.date = date;
        existingMessage.quoteText = quoteText ?? existingMessage.quoteText;
        if (modelParts !== undefined) {
            existingMessage.modelParts = modelParts;
        }

        if (fileBuffer) {
            existingMessage.file = fileBuffer;
            await existingMessage.save();
            return;
        }

        await existingMessage.save();

        if (fileLink) {
            saveFile(fileLink);
        }

        return;
    }

    if (replyToId) {
        Message.findOne({ where: { chatId, messageId: replyToId } }).then((msg) => {
            if (msg) {
                const replies = JSON.parse(msg.replies);
                replies.push(messageId);
                msg.replies = JSON.stringify(replies);
                msg.save();
            }
        });
    }

    await Message.create({
        chatId,
        messageId,
        fromBotSelf,
        text: message,
        quoteText,
        date,
        userName,
        file: fileBuffer,
        replyToId,
        replies: '[]',
        modelParts: modelParts ?? null,
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
 * Create a new bot response record
 */
const createBotResponse = async (
    chatId: number,
    messageId: number,
    userMessageId: number,
    metadata: ResponseMetadata
): Promise<BotResponse> => {
    return BotResponse.create({
        messageId,
        chatId,
        userMessageId,
        currentVersionIndex: 0,
        versions: '[]',
        buttonState: ButtonState.PROCESSING,
        metadata: JSON.stringify(metadata),
    });
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
    ButtonState,
    type ResponseVersion,
    type ResponseMetadata,
    type CommandType,
}
