const COST_NOTES: readonly string[] = [
    '按官方标价估算，不是账单：未计中转站（ephone 等）的分组倍率。',
    '未计 Vertex 试用额度与促销返还、DeepSeek 峰谷价（单价表取峰时价，偏高）。',
    '未计 Gemini 搜索接地与 xAI 服务端工具的按次费用、超长上下文档位。',
    '/picgpt 的整行未定价（实际花费是底座 token 加生图调用两部分）。',
    'Priority PayGo 按每轮实际服务的档位计价，优先档为标准档的 1.8 倍；命中率只算请求了 Priority 的回复，没请求却按优先档服务的轮次单独列出。',
];

const LATENCY_NOTES: readonly string[] = [
    '首字延迟跨平台不可比：Anthropic 整条缓冲，开工具的 OpenAI / DeepSeek / MiMo 按轮缓冲，「首字」约等于首轮完成。',
];

const COVERAGE_NOTES: readonly string[] = [
    '不含：工具内嵌的 generate_image、/picgrok、/vid 的分镜、进程重启打断的回复、请求发出前就失败的回复。',
    '数据来自每次回复写入的 reply_metrics，永久保留，不设保留期。',
];

/** The fixed disclaimers under the statistics (design §6.5) */
export const StatsNotes = () => (
    <section className="section">
        <details className="collapsible">
            <summary className="collapsible-summary">
                <span>说明（估算口径、不含的调用）</span>
            </summary>
            <div className="collapsible-body">
                <ul className="list compact">
                    {[...COST_NOTES, ...LATENCY_NOTES, ...COVERAGE_NOTES].map((note) => (
                        <li key={note} className="hint">
                            {note}
                        </li>
                    ))}
                </ul>
            </div>
        </details>
    </section>
);
