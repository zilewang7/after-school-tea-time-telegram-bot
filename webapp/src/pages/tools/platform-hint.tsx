import { CollapsibleSection } from '../../components/collapsible-section';
import type { ChannelPlan, ClientPlatform, RichChannel } from '../../tools/types';
import type { PlatformInfo } from './use-platform-info';

const PLATFORM_LABELS: Readonly<Record<ClientPlatform, string>> = {
    tdesktop: 'Telegram Desktop',
    android: 'Android',
    ios: 'iOS',
    macos: 'macOS',
    web: 'Telegram Web',
    unknown: '未知客户端',
};

const CHANNEL_LABELS: Readonly<Record<RichChannel, string>> = {
    'rich-html': '富文本 HTML',
    markdown: 'Markdown 文本',
    plain: '纯文本',
};

const supportLabelOf = (supported: boolean): string => (supported ? '支持' : '不支持');

interface PlatformHintProps {
    info: PlatformInfo;
    plan: ChannelPlan;
}

/** Current platform, the recommended copy channel, and a clipboard capability self-check */
export const PlatformHint = ({ info, plan }: PlatformHintProps) => (
    <section className="section">
        <div className="tools-platform-row">
            <span className="tools-platform-label">当前平台</span>
            <span className="tools-platform-value">{PLATFORM_LABELS[info.platform]}</span>
            <span className="hint">推荐通道：{CHANNEL_LABELS[plan.recommended]}</span>
        </div>
        <CollapsibleSection title="能力自检" summary={null}>
            <ul className="tools-check-list">
                <li>写富文本剪贴板：{supportLabelOf(info.htmlSupported)}</li>
                <li>粘贴事件：{supportLabelOf(info.pasteSupported)}</li>
                <li>直接读取剪贴板：{supportLabelOf(info.clipboardReadSupported)}</li>
            </ul>
        </CollapsibleSection>
    </section>
);
