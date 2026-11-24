/**
 * Message-kind cases (#16): a poll, a contact card and a real service event are
 * posted by the userbot and read back from the test bot's own database, where
 * the [sent a poll: …] / [sent a contact: …] / [service: …] annotations the model
 * context and the panel use are written. No model turn is involved, so these are
 * quick and deterministic; the rendering itself is covered by the offline tests.
 */
import {
    expect,
    pinAsUser,
    sendAsUser,
    sendContactAsUser,
    sendPollAsUser,
    unpinAsUser,
    waitForStoredMessage,
    waitForStoredMessageKind,
    waitForStoredServiceMessage,
} from './harness.mts';
import type { E2eCase } from './suite-helpers.mts';

/** Unique enough that a stale row of an earlier run can never satisfy a case */
const stamp = (): string =>
    `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

export const messageKindCases: E2eCase[] = [
    {
        name: 'a poll is stored as a poll annotation with its question and options',
        body: async () => {
            const marker = `KIND-POLL-${stamp()}`;
            const options = ['选项甲', '选项乙'];
            const messageId = await sendPollAsUser({ question: `${marker}?`, options });
            const stored = await waitForStoredMessageKind(messageId);
            expect(stored.kind === 'poll', `stored kind is poll (got: ${String(stored.kind)})`);
            const detail = stored.detail ?? '';
            expect(
                detail.includes(marker) && options.every((option) => detail.includes(option)),
                `the annotation names the question and both options (got: ${detail})`
            );
        },
    },
    {
        name: 'a contact card is stored as a contact annotation',
        body: async () => {
            const marker = `KIND-CONTACT-${stamp()}`;
            const messageId = await sendContactAsUser({
                firstName: marker,
                lastName: 'Harness',
                phone: '+15550001002',
            });
            const stored = await waitForStoredMessageKind(messageId);
            expect(stored.kind === 'contact', `stored kind is contact (got: ${String(stored.kind)})`);
            const detail = stored.detail ?? '';
            expect(
                detail.includes(marker) && detail.includes('+15550001002'),
                `the annotation names the contact and its phone (got: ${detail})`
            );
        },
    },
    {
        name: 'a pinned message is stored as a service annotation',
        body: async () => {
            const marker = `KIND-SERVICE-${stamp()}`;
            const messageId = await sendAsUser(`${marker} 这条消息会被置顶`);
            await waitForStoredMessage(messageId);
            await pinAsUser(messageId);
            try {
                const service = await waitForStoredServiceMessage(messageId, 'pinned a message');
                expect(
                    service.detail.includes(marker),
                    `the service annotation echoes the pinned text (got: ${service.detail})`
                );
            } finally {
                await unpinAsUser(messageId);
            }
        },
    },
];
