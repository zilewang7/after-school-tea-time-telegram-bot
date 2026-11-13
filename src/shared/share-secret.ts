/**
 * The HMAC key of the share family of signed URLs.
 *
 * WEBAPP_SHARE_SECRET when set, otherwise derived from BOT_TOKEN. Every signed
 * URL family (widget, media, public search page) derives from this one key with
 * its own domain separation, so a token of one family can never be replayed as
 * another.
 *
 * Lives in the shared layer so a lower layer (the version replay in services,
 * the footer formatter in telegram) can sign or verify without importing panel.
 */
import { createHmac } from 'node:crypto';

/** Domain separation for the BOT_TOKEN-derived secret */
const SECRET_CONTEXT = 'k-on-bot-share-secret';

export const shareSecretOf = (botToken: string, configuredSecret: string | undefined): Buffer => {
    const secret = (configuredSecret ?? process.env.WEBAPP_SHARE_SECRET ?? '').trim();
    if (secret !== '') return Buffer.from(secret, 'utf8');
    return createHmac('sha256', botToken).update(SECRET_CONTEXT).digest();
};
