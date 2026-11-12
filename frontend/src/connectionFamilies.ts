import { Database, FolderOpen } from "lucide-react";
import type { Connector, ConnectorFamily } from "./types";

export const FAMILIES = [
  { family: "database", label: "databasesAndWarehouses", icon: Database },
  { family: "storage", label: "fileStorage", icon: FolderOpen },
] as const;

/** Definitions without the storage family are databases: the catalog accepts no other family. */
export const familyOf = (connector?: Connector): ConnectorFamily =>
  connector?.family === "storage" ? "storage" : "database";
