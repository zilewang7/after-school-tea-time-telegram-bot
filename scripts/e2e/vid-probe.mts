/**
 * One-off manual probe for `/vid`'s reference-image paths.
 *
 * Not part of the suite — H3 takes minutes per clip, the GPU runs one job at a
 * time, and the box it runs on is only sometimes up. Run against an
 * already-running test bot:
 *   docker compose --profile test up -d k-on-bot-test
 *   npx tsx scripts/e2e/vid-probe.mts            # single-image Ref2VA
 *   npx tsx scripts/e2e/vid-probe.mts i2va       # the same image as frame 0
 *
 * The point of the i2va run is to compare the two conditioning modes on the
 * same picture: Ref2VA should keep the subject but re-stage the shot, i2va
 * should start on the picture exactly.
 */
import {
    BOT_USERNAME,
    COMFY_FORWARD_URL,
    expect,
    sendPhotoAsUser,
    waitForStoredMediaReply,
} from './harness.mts';

if (!COMFY_FORWARD_URL) throw new Error('COMFY_FORWARD_URL is not set in .env.test');

const mode = process.argv[2] ?? 'auto';
const modeFlag = mode === 'auto' ? '' : `-mode=${mode} `;

const health = await fetch(`${COMFY_FORWARD_URL}/health`).then((r) => r.json());
console.log('comfy health:', health);

/** The two fields this probe prints; the server's JSON is checked, not trusted */
interface ListedWorkflow {
    readonly id: string;
    readonly kind: string;
}
const isListedWorkflow = (value: unknown): value is ListedWorkflow =>
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'kind' in value &&
    typeof value.kind === 'string';

const workflowsBody: unknown = await fetch(`${COMFY_FORWARD_URL}/v1/workflows`).then((r) => r.json());
const listedWorkflows =
    typeof workflowsBody === 'object' && workflowsBody !== null && 'workflows' in workflowsBody
        ? workflowsBody.workflows
        : [];
console.log(
    'video workflows:',
    (Array.isArray(listedWorkflows) ? listedWorkflows.filter(isListedWorkflow) : [])
        .filter((workflow) => workflow.kind.endsWith('-to-video'))
        .map((workflow) => workflow.id)
);

const trigger = await sendPhotoAsUser('ocr-sample.png', {
    caption: `/vid@${BOT_USERNAME} ${modeFlag}-d=5 -steps=4 the camera pushes in slowly while neon light sweeps across the scene`,
});
console.log(`sent picture ${trigger} (mode=${mode}), waiting for the clip…`);

const videoId = await waitForStoredMediaReply(trigger, {
    timeoutMs: 900_000,
    mimePrefix: 'video/',
    noun: 'video',
});
expect(videoId > trigger, `the clip came back and was stored (${videoId})`);
