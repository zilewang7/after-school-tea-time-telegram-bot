import './tools.css';
import { useCallback, useMemo, useState } from 'react';
import { channelPlanOf } from '../../tools/platform-channel';
import { DirectionSwitch } from './direction-switch';
import type { ToolDirection } from './direction-switch';
import { ForwardPanel } from './md-entities/forward-panel';
import { ReversePanel } from './md-entities/reverse-panel';
import { PlatformHint } from './platform-hint';
import { usePlatformInfo } from './use-platform-info';

/** /tools: convert between markdown and Telegram entities through the clipboard */
export const ToolsTab = () => {
    const [direction, setDirection] = useState<ToolDirection>('forward');
    const platformInfo = usePlatformInfo();
    const plan = useMemo(
        () => channelPlanOf(platformInfo.platform, platformInfo.htmlSupported),
        [platformInfo.platform, platformInfo.htmlSupported]
    );

    const handleDirectionChange = useCallback((next: ToolDirection) => setDirection(next), []);

    return (
        <>
            <header className="page-header">
                <h1>剪贴板转换</h1>
                <p className="hint">Markdown 与 Telegram 富文本互相转换；内容只在本机处理，不会上传服务器。</p>
            </header>
            <section className="section">
                <DirectionSwitch value={direction} onChange={handleDirectionChange} />
            </section>
            <PlatformHint info={platformInfo} plan={plan} />
            {/* Both panels stay mounted, so switching direction keeps the typed text */}
            <div hidden={direction !== 'forward'}>
                <ForwardPanel plan={plan} />
            </div>
            <div hidden={direction !== 'reverse'}>
                <ReversePanel plan={plan} readSupported={platformInfo.clipboardReadSupported} />
            </div>
            <p className="hint">
                剪贴板内容不会离开设备。iOS 首次粘贴可能弹系统授权提示；Android 13+ 会显示剪贴板预览，属系统行为。
            </p>
        </>
    );
};
