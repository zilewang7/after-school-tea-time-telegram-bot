declare global {
    // 文件组标识
    var mediaGroupIdTemp: {
        chatId: number;
        messageId: number;
        mediaGroupId: string;
    };
    // 正在保存中的文件 id
    var asynchronousFileSaveMsgIdList: number[];
    // 当前的模型
    var currentModel: string;
    // 消息编辑接口调用限流
    var editRateLimiter: {
        [chatId: number | string]: {
            count: number;
            startTimestamp: number;
            lastEditTimestamp: number;
        }
    };
}