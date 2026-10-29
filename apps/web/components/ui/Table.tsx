"use client";

import { useMemo, useState } from "react";
import { Search, ArrowUpDown, ArrowUp, ArrowDown, X } from "lucide-react";

export interface TableColumn<T> {
  header: string;
  render: (row: T) => React.ReactNode;
  sortable?: boolean;
  sortKey?: keyof T | ((row: T) => string | number | boolean | null | undefined);
  className?: string;
}

export interface TableProps<T extends { id: string }> {
  columns: TableColumn<T>[];
  rows: T[];
  emptyMessage?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
}

export function Table<T extends { id: string }>({
  columns,
  rows,
  emptyMessage = "Nenhum registro encontrado.",
  searchable = false,
  searchPlaceholder = "Filtrar nesta tabela…",
}: TableProps<T>): React.JSX.Element {
  const [searchTerm, setSearchTerm] = useState("");
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  // Filtro de busca simples e responsivo
  const filteredRows = useMemo(() => {
    if (!searchTerm.trim()) return rows;
    const term = searchTerm.toLowerCase();

    return rows.filter((row) => {
      // 1. Procura em chaves do objeto
      for (const key of Object.keys(row)) {
        const val = (row as Record<string, unknown>)[key];
        if (typeof val === "string" && val.toLowerCase().includes(term)) return true;
        if (typeof val === "number" && String(val).includes(term)) return true;
      }
      return false;
    });
  }, [rows, searchTerm]);

  // Ordenação de colunas
  const sortedRows = useMemo(() => {
    if (!sortCol) return filteredRows;
    const colDef = columns.find((c) => c.header === sortCol);
    if (!colDef) return filteredRows;

    return [...filteredRows].sort((a, b) => {
      let valA: unknown = (a as Record<string, unknown>)[sortCol];
      let valB: unknown = (b as Record<string, unknown>)[sortCol];

      if (typeof colDef.sortKey === "function") {
        valA = colDef.sortKey(a);
        valB = colDef.sortKey(b);
      } else if (typeof colDef.sortKey === "string") {
        valA = (a as Record<string, unknown>)[colDef.sortKey];
        valB = (b as Record<string, unknown>)[colDef.sortKey];
      }

      if (valA === valB) return 0;
      if (valA === null || valA === undefined) return 1;
      if (valB === null || valB === undefined) return -1;

      let cmp = 0;
      if (typeof valA === "number" && typeof valB === "number") {
        cmp = valA - valB;
      } else {
        cmp = String(valA).localeCompare(String(valB), "pt-BR", { numeric: true });
      }

      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filteredRows, sortCol, sortDir, columns]);

  const toggleSort = (header: string, isSortable?: boolean): void => {
    if (!isSortable) return;
    if (sortCol === header) {
      if (sortDir === "asc") {
        setSortDir("desc");
      } else {
        setSortCol(null);
        setSortDir("asc");
      }
    } else {
      setSortCol(header);
      setSortDir("asc");
    }
  };

  if (rows.length === 0) return <p className="cc-muted">{emptyMessage}</p>;

  return (
    <div className="cc-table-container">
      {searchable ? (
        <div className="cc-table-toolbar">
          <div className="cc-table-search">
            <Search className="cc-table-search-icon" size={14} aria-hidden="true" />
            <input
              type="text"
              className="cc-table-search-input"
              placeholder={searchPlaceholder}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              aria-label={searchPlaceholder}
            />
            {searchTerm ? (
              <button
                type="button"
                className="cc-table-search-clear"
                onClick={() => setSearchTerm("")}
                aria-label="Limpar filtro"
                title="Limpar filtro"
              >
                <X size={13} />
              </button>
            ) : null}
          </div>
          <span className="cc-muted cc-text-xs">
            {sortedRows.length} de {rows.length} {rows.length === 1 ? "registro" : "registros"}
          </span>
        </div>
      ) : null}

      <div className="cc-table-wrap">
        <table className="cc-table">
          <thead>
            <tr>
              {columns.map((c) => {
                const isSortable = Boolean(c.sortable || c.sortKey);
                const isCurrentSort = sortCol === c.header;

                return (
                  <th
                    key={c.header}
                    scope="col"
                    className={`${c.className ?? ""} ${isSortable ? "cc-table-th-sortable" : ""}`.trim()}
                    onClick={() => toggleSort(c.header, isSortable)}
                    aria-sort={
                      isCurrentSort
                        ? sortDir === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    <div className="cc-table-th-content">
                      <span>{c.header}</span>
                      {isSortable ? (
                        <span className="cc-table-sort-indicator" aria-hidden="true">
                          {isCurrentSort ? (
                            sortDir === "asc" ? (
                              <ArrowUp size={12} />
                            ) : (
                              <ArrowDown size={12} />
                            )
                          ) : (
                            <ArrowUpDown size={12} className="cc-muted" />
                          )}
                        </span>
                      ) : null}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="cc-table-empty-cell">
                  <p className="cc-muted">
                    Nenhum registro corresponde ao filtro &ldquo;{searchTerm}&rdquo;.
                  </p>
                  <button
                    type="button"
                    className="cc-btn cc-btn-secondary cc-u-mt-2"
                    onClick={() => setSearchTerm("")}
                  >
                    Limpar filtro
                  </button>
                </td>
              </tr>
            ) : (
              sortedRows.map((row) => (
                <tr key={row.id}>
                  {columns.map((c) => (
                    <td key={c.header} className={c.className}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
