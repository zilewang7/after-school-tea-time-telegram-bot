import { sequelize } from "./config";
import { Message } from "./messageDTO";
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
        replyToId?: number
    }
) => {
    const { chatId, messageId, userId, date = new Date(), userName = '佚名', message, quoteText, fileLink, replyToId } = info;

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

    if (await Message.findOne({ where: { chatId, messageId } })) {
        await Message.update({ text: message, date, quoteText }, { where: { chatId, messageId } });

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
        replyToId,
        replies: '[]',
    });

    if (fileLink) {
        saveFile(fileLink);
    }
}

const getMessage = async (chatId: number, messageId: number) => {
    const message = await Message.findOne({ where: { chatId, messageId } });
    return message;
}

export { saveMessage, getMessage }