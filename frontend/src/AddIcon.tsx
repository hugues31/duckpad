import { createElement, useId } from "react";
import { createLucideIcon, type IconNode } from "lucide-react";

/** Outline glyphs drawn on a 24 × 24 grid, in the Lucide stroke style. */
const GLYPHS: Record<"duckdb" | "python" | "import", IconNode> = {
  // The DuckDB mark: a disc holding a circle and a bill.
  duckdb: [
    ["circle", { cx: "12", cy: "12", r: "10", key: "disc" }],
    ["circle", { cx: "9", cy: "12", r: "4", key: "head" }],
    ["path", { d: "M16.75 12h1.25", strokeWidth: "3.5", key: "bill" }],
  ],
  // The Python mark: two interlocked snakes, each with an eye.
  python: [
    [
      "path",
      {
        d: "M12 8.5H5.5A2.5 2.5 0 0 0 3 11v3a2.5 2.5 0 0 0 2.5 2.5H8",
        key: "left",
      },
    ],
    [
      "path",
      {
        d: "M12 15.5h6.5A2.5 2.5 0 0 0 21 13v-3a2.5 2.5 0 0 0-2.5-2.5H16",
        key: "right",
      },
    ],
    [
      "path",
      {
        d: "M8 8.5v-3A2.5 2.5 0 0 1 10.5 3h3A2.5 2.5 0 0 1 16 5.5V10a2 2 0 0 1-2 2h-4a2 2 0 0 0-2 2v4.5a2.5 2.5 0 0 0 2.5 2.5h3a2.5 2.5 0 0 0 2.5-2.5v-3",
        key: "body",
      },
    ],
    ["path", { d: "M10.5 5.75h.01", key: "top-eye" }],
    ["path", { d: "M13.5 18.25h.01", key: "bottom-eye" }],
  ],
  // Lucide's download arrow and tray.
  import: [
    ["path", { d: "M12 15V3", key: "shaft" }],
    ["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", key: "tray" }],
    ["path", { d: "m7 10 5 5 5-5", key: "head" }],
  ],
};

/** The Python mark as a Lucide icon, for Python nodes. */
export const PythonIcon = createLucideIcon("Python", GLYPHS.python);

/** A glyph shrunk into the lower left, with a "+" in the top right corner. */
export default function AddIcon({
  glyph,
  size = 22,
}: {
  glyph: keyof typeof GLYPHS;
  size?: number;
}) {
  // useId may contain characters that need escaping in url() references.
  const mask = `add-icon-${useId().replace(/[^\w-]/g, "")}`;
  return (
    <svg
      className="add-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <mask id={mask}>
        <rect width="24" height="24" fill="#fff" />
        <circle cx="19.5" cy="4.5" r="5" fill="#000" />
      </mask>
      <g mask={`url(#${mask})`}>
        {/* Scaling to 80 % keeps strokes at 2 units with a 2.5 width. */}
        <g transform="translate(0 4.8) scale(0.8)" strokeWidth={2.5}>
          {GLYPHS[glyph].map(([tag, attrs]) =>
            createElement(String(tag), attrs),
          )}
        </g>
      </g>
      <path d="M19.5 1.5v6M16.5 4.5h6" />
    </svg>
  );
}
