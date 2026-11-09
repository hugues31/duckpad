import type { ReactNode } from "react";
import { formatValue } from "./graph";
import type { Column, Json } from "./types";

/** Shared row numbering and table structure; callers own sorting and cell actions. */
export default function DataGrid({
  columns,
  rows,
  offset = 0,
  header,
  cell,
  children,
}: {
  columns: Column[];
  rows: { id: number; values: Json[] }[];
  offset?: number;
  header?: (column: Column) => ReactNode;
  cell?: (
    value: Json,
    column: Column,
    row: { id: number; values: Json[] },
  ) => ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="data-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th className="row-number">#</th>
            {columns.map((column) => (
              <th key={column.name} data-column={column.name}>
                {header ? (
                  header(column)
                ) : (
                  <span className="column-heading">
                    <span>{column.name}</span>
                    <small>{column.type}</small>
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.id}>
              <td className="row-number">{offset + index + 1}</td>
              {row.values.map((value, index) => (
                <td key={index}>
                  {cell ? (
                    cell(value, columns[index], row)
                  ) : (
                    <span
                      className={`cell-text ${value === null ? "null" : ""}`}
                    >
                      {formatValue(value)}
                    </span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {children}
    </div>
  );
}
