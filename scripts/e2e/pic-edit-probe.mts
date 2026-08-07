/**
 * One-off manual probe for the image-edit half of /pic: post a picture whose
 * caption is the command, and check a generated picture comes back.
 *
 * Not part of the suite — FLUX.2 takes minutes, and the box it runs on is only
 * sometimes up. Run against an already-running test bot:
 *   docker compose --profile test up -d k-on-bot-test
 *   npx tsx scripts/e2e/pic-edit-probe.mts
 */
import {
    BOT_USERNAME,
    COMFY_FORWARD_URL,
    expect,
    sendPhotoAsUser,
    waitForStoredImageReply,
} from './harness.mts';

if (!COMFY_FORWARD_URL) throw new Error('COMFY_FORWARD_URL is not set in .env.test');

const health = await fetch(`${COMFY_FORWARD_URL}/health`).then((r) => r.json());
console.log('comfy health:', health);

const trigger = await sendPhotoAsUser('ocr-sample.png', {
    caption: `/pic@${BOT_USERNAME} -steps=8 turn the background into a night city skyline`,
});
console.log(`sent picture ${trigger}, waiting for the edit…`);

const pictureId = await waitForStoredImageReply(trigger, 600_000);
expect(pictureId > trigger, `the edited picture came back and was stored (${pictureId})`);
