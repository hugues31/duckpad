/**
 * The icons a node can declare with `@icon`: stable Duckpad names for Lucide
 * glyphs, and glyphs drawn here in the same style for the data operations
 * Lucide has none for.
 */
import {
  ArrowLeftRight,
  ArrowUpDown,
  Bell,
  BookOpen,
  Braces,
  Brain,
  Briefcase,
  Building2,
  Calculator,
  Calendar,
  CalendarClock,
  ChartColumn,
  ChartLine,
  ChartPie,
  ChartScatter,
  CircleCheck,
  Clock,
  Cloud,
  Code2,
  Coins,
  Columns3,
  CopyMinus,
  Cpu,
  createLucideIcon,
  Database,
  DollarSign,
  Download,
  Euro,
  EyeOff,
  Factory,
  FileInput,
  FileOutput,
  FileSpreadsheet,
  FileText,
  Filter,
  Flag,
  FlaskConical,
  Folder,
  GalleryHorizontal,
  Gauge,
  GitMerge,
  Globe,
  Group,
  Handshake,
  HardDrive,
  Hash,
  HeartPulse,
  History,
  House,
  Key,
  Landmark,
  Layers,
  Leaf,
  ListTree,
  Lock,
  Mail,
  Map as MapIcon,
  Monitor,
  Network,
  Package,
  PaintBucket,
  Percent,
  Pipette,
  Plane,
  Plug,
  Radio,
  RadioTower,
  ReceiptText,
  RefreshCw,
  Regex,
  Replace,
  Rocket,
  Scale,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Ship,
  ShoppingCart,
  Sigma,
  Smartphone,
  Sparkles,
  Split,
  SquareFunction,
  Star,
  Store,
  Table,
  Tag,
  Tally5,
  Target,
  TextCursorInput,
  Thermometer,
  TrendingUp,
  TriangleAlert,
  Truck,
  Type,
  Upload,
  User,
  Users,
  Variable,
  Wallet,
  Warehouse,
  Webhook,
  Zap,
  type IconNode,
  type LucideIcon,
} from "lucide-react";
import { PythonIcon } from "./AddIcon";

export type NodeIconGroup = "data" | "misc";

export interface NodeIconChoice {
  /** The name written after `@icon`. */
  name: string;
  group: NodeIconGroup;
  /** Other English words the picker and the editor find the icon by. */
  keywords: string;
  Icon: LucideIcon;
}

// Two tables of a join, as circles of radius 6.5 that cross at x = 12, from
// y = 6 to y = 18: the overlap is wide enough to read at palette size.
const LEFT = { cx: "9.5", cy: "12", r: "6.5" };
const RIGHT = { cx: "14.5", cy: "12", r: "6.5" };
const SHADED = { fill: "currentColor", fillOpacity: "0.4", stroke: "none" };
/** The rows a join keeps, shaded under the outlines. */
const kept = (d: string): IconNode[number] => [
  "path",
  { d, ...SHADED, key: "kept" },
];
const BOTH = "M12 6a6.5 6.5 0 0 1 0 12 6.5 6.5 0 0 1 0-12z";
const LEFT_ONLY = "M12 6a6.5 6.5 0 1 0 0 12 6.5 6.5 0 0 1 0-12z";
const EITHER = "M12 6a6.5 6.5 0 1 0 0 12 6.5 6.5 0 1 0 0-12z";
const venn = (name: string, ...shaded: IconNode) =>
  createLucideIcon(name, [
    ...shaded,
    ["circle", { ...LEFT, key: "left" }],
    ["circle", { ...RIGHT, key: "right" }],
  ]);
const disc = (circle: typeof LEFT): IconNode[number] => [
  "circle",
  { ...circle, ...SHADED, key: "kept" },
];

const InnerJoin = venn("InnerJoin", kept(BOTH));
const LeftJoin = venn("LeftJoin", disc(LEFT));
const RightJoin = venn("RightJoin", disc(RIGHT));
const FullJoin = venn("FullJoin", kept(EITHER));
const AntiJoin = venn("AntiJoin", kept(LEFT_ONLY));

/** Two tables stacked into one: the second one is appended. */
const Union = createLucideIcon("Union", [
  ["rect", { x: "3", y: "3", width: "18", height: "7", rx: "1.5", key: "a" }],
  [
    "rect",
    {
      x: "3",
      y: "14",
      width: "18",
      height: "7",
      rx: "1.5",
      fill: "currentColor",
      fillOpacity: "0.4",
      key: "b",
    },
  ],
]);

// A column of values on the left and a row of headers on top, joined by the
// turn that makes one into the other.
const PIVOT_FRAME: IconNode = [
  ["rect", { x: "3", y: "10", width: "5", height: "11", rx: "1", key: "rows" }],
  ["rect", { x: "10", y: "3", width: "11", height: "5", rx: "1", key: "top" }],
  ["path", { d: "M12 18h2a4 4 0 0 0 4-4v-2", key: "turn" }],
];
const Pivot = createLucideIcon("Pivot", [
  ...PIVOT_FRAME,
  ["path", { d: "m15.5 14.5 2.5-2.5 2.5 2.5", key: "head" }],
]);
const Unpivot = createLucideIcon("Unpivot", [
  ...PIVOT_FRAME,
  ["path", { d: "m14.5 15.5-2.5 2.5 2.5 2.5", key: "head" }],
]);

const choices = (
  group: NodeIconGroup,
  entries: [name: string, Icon: LucideIcon, keywords: string][],
): NodeIconChoice[] =>
  entries.map(([name, Icon, keywords]) => ({ name, group, keywords, Icon }));

/** Every icon, in the order the picker and the documentation list them. */
export const NODE_ICONS: readonly NodeIconChoice[] = [
  ...choices("data", [
    // Where data comes from and goes.
    ["table", Table, "dataset relation grid"],
    ["database", Database, "db warehouse storage"],
    ["file", FileText, "document text"],
    ["spreadsheet", FileSpreadsheet, "excel csv xlsx sheet"],
    ["json", Braces, "object document nested"],
    ["import", FileInput, "load read source input"],
    ["export", FileOutput, "write output destination"],
    ["download", Download, "pull fetch extract"],
    ["upload", Upload, "push publish send"],
    ["folder", Folder, "directory files"],
    ["cloud", Cloud, "bucket object storage remote"],
    ["api", Webhook, "http rest webhook service"],
    // Rows and columns.
    ["filter", Filter, "where funnel condition"],
    ["sort", ArrowUpDown, "order rank"],
    ["sample", Pipette, "extract subset limit"],
    ["deduplicate", CopyMinus, "distinct unique duplicates"],
    ["columns", Columns3, "select fields projection"],
    ["rename", TextCursorInput, "alias name"],
    ["convert", ArrowLeftRight, "cast type map"],
    ["clean", Sparkles, "tidy quality prepare"],
    ["replace", Replace, "substitute values"],
    ["fill", PaintBucket, "nulls default coalesce impute"],
    ["split", Split, "branch route separate"],
    ["unnest", ListTree, "explode flatten nested hierarchy"],
    ["search", Search, "find lookup match"],
    // Values.
    ["text", Type, "string varchar characters"],
    ["number", Hash, "numeric integer identifier"],
    ["date", Calendar, "day month year"],
    ["time", Clock, "timestamp hour duration"],
    ["regex", Regex, "pattern extract match"],
    ["key", Key, "primary identifier secret"],
    // Several inputs.
    ["join", GitMerge, "merge combine lookup"],
    ["inner-join", InnerJoin, "intersect matching both"],
    ["left-join", LeftJoin, "outer lookup enrich"],
    ["right-join", RightJoin, "outer"],
    ["full-join", FullJoin, "outer all"],
    ["anti-join", AntiJoin, "except missing not exists difference"],
    ["union", Union, "append concatenate stack rows"],
    // Computations.
    ["aggregate", Sigma, "sum total measures"],
    ["group", Group, "group by cluster bucket"],
    ["count", Tally5, "tally total number"],
    ["formula", SquareFunction, "function expression calculation"],
    ["variable", Variable, "parameter value"],
    ["calculator", Calculator, "compute math arithmetic"],
    ["percent", Percent, "ratio share rate"],
    ["compare", Scale, "balance difference reconcile"],
    ["window", GalleryHorizontal, "rolling moving over partition"],
    ["pivot", Pivot, "crosstab wide reshape"],
    ["unpivot", Unpivot, "melt long reshape"],
    // Code and quality.
    ["sql", Code2, "code query"],
    ["python", PythonIcon, "code script"],
    ["test", FlaskConical, "check experiment assert quality"],
    ["check", CircleCheck, "valid approve done"],
    ["warning", TriangleAlert, "alert anomaly error"],
    ["shield", ShieldCheck, "security protect compliance"],
    ["mask", EyeOff, "anonymize hide privacy"],
    // Analysis.
    ["chart-bar", ChartColumn, "histogram report"],
    ["chart-line", ChartLine, "time series curve"],
    ["chart-pie", ChartPie, "share breakdown"],
    ["chart-scatter", ChartScatter, "correlation points"],
    ["trend", TrendingUp, "growth forecast increase"],
    ["gauge", Gauge, "indicator metric speed"],
    ["target", Target, "goal objective score"],
    ["brain", Brain, "model machine learning predict"],
    ["network", Network, "graph hierarchy tree relations"],
    ["map", MapIcon, "geography spatial location"],
    // Pipelines.
    ["history", History, "snapshot versions past"],
    ["schedule", CalendarClock, "planned recurring job"],
    ["refresh", RefreshCw, "incremental update sync"],
    ["layers", Layers, "staging stack levels"],
  ]),
  ...choices("misc", [
    // Places.
    ["house", House, "home housing"],
    ["building", Building2, "office company"],
    ["factory", Factory, "plant industry production"],
    ["store", Store, "shop retail"],
    ["warehouse", Warehouse, "stock logistics inventory"],
    ["bank", Landmark, "institution finance government"],
    // Money.
    ["euro", Euro, "currency money price"],
    ["dollar", DollarSign, "currency money price"],
    ["coins", Coins, "money cash revenue"],
    ["wallet", Wallet, "budget payment"],
    ["receipt", ReceiptText, "invoice bill ticket"],
    ["cart", ShoppingCart, "orders sales basket"],
    // Machines.
    ["computer", Monitor, "desktop screen"],
    ["phone", Smartphone, "mobile device"],
    ["hard-drive", HardDrive, "disk storage"],
    ["server", Server, "host machine rack"],
    ["cpu", Cpu, "processor chip compute"],
    ["sensor", Radio, "probe signal measure"],
    ["thermometer", Thermometer, "temperature weather"],
    ["antenna", RadioTower, "telecom broadcast"],
    ["plug", Plug, "connector socket"],
    ["energy", Zap, "power electricity lightning"],
    // People.
    ["user", User, "person customer"],
    ["users", Users, "team customers people"],
    ["briefcase", Briefcase, "business job work"],
    ["handshake", Handshake, "deal partner contract"],
    ["mail", Mail, "email message"],
    ["bell", Bell, "notification alert"],
    // Goods and transport.
    ["package", Package, "parcel product box"],
    ["truck", Truck, "delivery shipping logistics"],
    ["plane", Plane, "flight travel"],
    ["ship", Ship, "boat freight sea"],
    // Everything else.
    ["leaf", Leaf, "environment sustainability nature"],
    ["health", HeartPulse, "medical heart care"],
    ["book", BookOpen, "documentation reference library"],
    ["settings", Settings, "configuration gear"],
    ["rocket", Rocket, "launch deploy fast"],
    ["flag", Flag, "mark milestone country"],
    ["star", Star, "favorite rating gold"],
    ["tag", Tag, "label category"],
    ["globe", Globe, "world web international"],
    ["lock", Lock, "secure private"],
  ]),
];

const BY_NAME = new Map(NODE_ICONS.map((choice) => [choice.name, choice]));

/** `Filter ` -> `filter`, as the server reads the names after `@icon`. */
export const appearanceName = (name: string | undefined) =>
  (name ?? "").trim().toLowerCase();

/** The icon of a name; undefined for a name Duckpad cannot draw. */
export const nodeIcon = (name: string | undefined) =>
  BY_NAME.get(appearanceName(name));

/** The icons whose name or keywords contain every word of a search. */
export function findNodeIcons(search: string) {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  return NODE_ICONS.filter((choice) =>
    words.every(
      (word) => choice.name.includes(word) || choice.keywords.includes(word),
    ),
  );
}
