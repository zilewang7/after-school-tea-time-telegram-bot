import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';

interface ChartCardProps {
    title: string;
    chart: ReactNode;
    // The same numbers as a table; the header button switches to it
    table: ReactNode;
    // Shown under the title, e.g. what the bars count
    hint?: string | null;
}

/** A chart with its numbers as a table behind the 「表格」 button (design §7) */
export const ChartCard = ({ title, chart, table, hint = null }: ChartCardProps) => {
    const [showTable, setShowTable] = useState(false);
    const toggle = useCallback(() => setShowTable((current) => !current), []);

    return (
        <section className="chart-card">
            <header className="chart-head">
                <h3 className="chart-title">{title}</h3>
                <button type="button" className="chart-toggle" aria-pressed={showTable} onClick={toggle}>
                    {showTable ? '图表' : '表格'}
                </button>
            </header>
            {hint !== null && <p className="hint">{hint}</p>}
            {showTable ? table : chart}
        </section>
    );
};
