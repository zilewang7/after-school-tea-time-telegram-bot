export interface ChartTableRow {
    key: string;
    // One value per column; the first column is the bucket or name
    cells: readonly string[];
}

interface ChartTableProps {
    columns: readonly string[];
    rows: readonly ChartTableRow[];
}

/** The numbers of a chart as a plain table (its accessible, always-readable form) */
export const ChartTable = ({ columns, rows }: ChartTableProps) => {
    if (rows.length === 0) return <p className="hint">没有数据</p>;
    return (
        <div className="chart-table-scroll">
            <table className="chart-table">
                <thead>
                    <tr>
                        {columns.map((column) => (
                            <th key={column} scope="col">
                                {column}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row) => (
                        <tr key={row.key}>
                            {row.cells.map((cell, index) =>
                                index === 0 ? (
                                    <th key={`${row.key}-${index}`} scope="row">
                                        {cell}
                                    </th>
                                ) : (
                                    <td key={`${row.key}-${index}`}>{cell}</td>
                                )
                            )}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};
