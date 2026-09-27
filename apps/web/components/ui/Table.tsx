"use client";

export interface TableColumn<T> {
  header: string;
  render: (row: T) => React.ReactNode;
}

export function Table<T extends { id: string }>({
  columns,
  rows,
  emptyMessage = "Nenhum registro encontrado.",
}: {
  columns: TableColumn<T>[];
  rows: T[];
  emptyMessage?: string;
}): React.JSX.Element {
  if (rows.length === 0) return <p className="cc-muted">{emptyMessage}</p>;
  return (
    <div className="cc-table-wrap">
      <table className="cc-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.header} scope="col">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {columns.map((c) => (
                <td key={c.header}>{c.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
