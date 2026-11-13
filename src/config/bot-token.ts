/**
 * The bot's token. `index.ts` refuses to start without it; a script or a test
 * that reaches a Bot API client without one fails here, by name, instead of
 * calling Telegram as `botundefined`.
 */
export const requireBotToken = (): string => {
    const botToken = process.env.BOT_TOKEN;
    if (!botToken) throw new Error('BOT_TOKEN must be provided');
    return botToken;
};
