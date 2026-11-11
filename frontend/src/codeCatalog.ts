import { api } from "./api";

/** A DuckDB function, its overloads folded by parameter names. */
export interface SqlFunction {
  name: string;
  kind: "scalar" | "aggregate" | "window" | "macro" | "table" | "table_macro";
  description: string;
  examples: string[];
  signatures: {
    /** A parameter type is empty when the overloads disagree on it. */
    parameters: { name: string; type: string }[];
    returns: string;
    varargs?: string;
  }[];
  /** Named options of a table function, such as `header` for read_csv. */
  options?: { name: string; type: string }[];
}
export interface PythonMember {
  name: string;
  kind: "method" | "property" | "class";
  signature: string;
  doc: string;
}
/** What the server's DuckDB offers to SQL and Python code. */
export interface CodeCatalog {
  duckdb_version: string;
  functions: SqlFunction[];
  keywords: {
    name: string;
    category: "reserved" | "unreserved" | "type_function" | "column_name";
  }[];
  types: string[];
  python: {
    relation: PythonMember[];
    connection: PythonMember[];
    module: PythonMember[];
  };
}

let catalog: Promise<CodeCatalog | null> | null = null;

/** The catalog, fetched once; a failure resolves to null and is retried later. */
export function loadCodeCatalog(): Promise<CodeCatalog | null> {
  catalog ??= api<CodeCatalog>("/code-catalog").catch(() => {
    catalog = null;
    return null;
  });
  return catalog;
}
