import { useMemo } from 'react';
import { serverNowMs } from '../../api';
import type { PricingMeta } from '../../api';
import { formatPriceTableVersion } from '../../format-metrics';

const COST_NOTES: readonly string[] = [
    '按官方标价估算，不是账单：未计中转站（ephone 等）的分组倍率。',
    '未计 Vertex 试用额度与促销返还、DeepSeek 峰谷价（单价表取峰时价，偏高）。',
    '未计 Gemini 搜索接地与 xAI 服务端工具的按次费用、超长上下文档位。',
    '/picgpt 的中转生图调用没有官方单次价，那一行即使有 token 价也可能偏低。',
    'Priority PayGo 按每轮实际服务的档位计价；命中率只算请求了 Priority 的回复，没请求却按优先档服务的轮次单独列出。',
];

const LATENCY_NOTES: readonly string[] = [
    '首字延迟跨平台不可比：Anthropic 整条缓冲，开工具的 OpenAI / DeepSeek / MiMo 按轮缓冲，「首字」约等于首轮完成。',
];

const COVERAGE_NOTES: readonly string[] = [
    '不含：工具内嵌的 generate_image、/picgrok、/vid 的分镜、进程重启打断的回复、请求发出前就失败的回复。',
    '数据来自每次回复写入的 reply_metrics，永久保留，不设保留期。',
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** `2026-12-01` from an ISO instant: price windows switch at UTC midnight */
const dateOf = (iso: string): string => iso.slice(0, 10);

/** Whole days between now and the instant; 0 = today */
const daysUntil = (iso: string, nowMs: number): number => Math.max(0, Math.floor((Date.parse(iso) - nowMs) / DAY_MS));

const countdownOf = (days: number): string =>
    days === 0 ? '今天' : days === 1 ? '明天' : `${days} 天后`;

/** The price table facts behind the numbers: version, freshness, next changes, gaps */
const pricingNotesOf = (pricing: PricingMeta, nowMs: number): readonly string[] => {
    const notes: string[] = [
        `价格表 ${formatPriceTableVersion(pricing.version)}，最近核对 ${pricing.checkedOn ?? '未知'}。`,
        '费用按每条回复开始时刻生效的价目估算，之后的调价不会改写历史金额。',
    ];
    for (const change of pricing.nextChanges) {
        notes.push(
            `${dateOf(change.at)}（${countdownOf(daysUntil(change.at, nowMs))}）起：${change.model} ${change.summary}。`
        );
    }
    if (pricing.nextChanges.length === 0) {
        notes.push('30 天内没有已公布的调价。');
    }
    if (pricing.unpricedModels.length > 0) {
        notes.push(`近 30 天出现但未定价：${pricing.unpricedModels.join('、')}。`);
    }
    if (pricing.pendingProposals > 0) {
        notes.push(`有 ${pricing.pendingProposals} 条调价提案待机主审批。`);
    }
    return notes;
};

interface StatsNotesProps {
    pricing: PricingMeta;
}

/** The disclaimers under the statistics (design §6.5), price facts from the API */
export const StatsNotes = ({ pricing }: StatsNotesProps) => {
    // The bot's clock (api/server-clock), so a skewed device does not misstate the countdown
    const pricingNotes = useMemo(() => pricingNotesOf(pricing, serverNowMs()), [pricing]);

    return (
        <section className="section">
            <details className="collapsible">
                <summary className="collapsible-summary">
                    <span>说明（估算口径、不含的调用）</span>
                </summary>
                <div className="collapsible-body">
                    <ul className="list compact">
                        {[...pricingNotes, ...COST_NOTES, ...LATENCY_NOTES, ...COVERAGE_NOTES].map((note) => (
                            <li key={note} className="hint">
                                {note}
                            </li>
                        ))}
                    </ul>
                </div>
            </details>
        </section>
    );
};
