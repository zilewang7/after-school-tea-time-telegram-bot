import { sequelize } from "./config";
import { Message } from "./messageDTO";
import { getBlob } from "../util";

// 同步数据库
sequelize.sync();

const saveMessage = async (
    info: {
        chatId: number,
        messageId: number,
        userId: number,
        date: Date,
        userName?: string,
        message?: string,
        fileLink?: string,
        replyToId?: number
    }
) => {
    const { chatId, messageId, userId, date = new Date(), userName = '佚名', message, fileLink, replyToId } = info;

    const fromBotSelf = userId === Number(process.env.BOT_USER_ID);

    //  异步保存文件
    const saveFile = async (fileLink: string) => {
        try {
            const blob = await getBlob(fileLink);
            const fileBuffer = blob ? Buffer.from(await blob.arrayBuffer()) : undefined

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
            global.asynchronousFileSaveMsgIdList = global.asynchronousFileSaveMsgIdList.filter(id => id !== messageId);
        }
    }

    if (await Message.findOne({ where: { chatId, messageId } })) {
        await Message.update({ text: message, date }, { where: { chatId, messageId } });

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