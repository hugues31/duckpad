import {
  Braces,
  CodeXml,
  Database,
  FileCode2,
  FileText,
  Settings2,
} from "lucide-react";

const icons = {
  md: FileText,
  markdown: FileText,
  json: Braces,
  py: CodeXml,
  sql: Database,
  toml: Settings2,
};

/** The same file type symbols appear in the tree and the editor heading. */
export default function ProjectFileIcon({ path }: { path: string }) {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  const Icon = icons[extension as keyof typeof icons] ?? FileCode2;
  return <Icon size={15} aria-hidden="true" />;
}
