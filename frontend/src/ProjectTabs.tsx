import { Link } from "react-router";
import { useEffect, useRef } from "react";
import {
  Activity,
  BookOpen,
  CalendarClock,
  FileCode2,
  Puzzle,
  Settings2,
  Variable,
  Workflow,
} from "lucide-react";
import { useT } from "./i18n";
import {
  projectPageUrl,
  usePageRoute,
  workspaceTabs,
  worktreeUrl,
} from "./navigation";

const icons = {
  flow: Workflow,
  code: FileCode2,
  documentation: BookOpen,
  variables: Variable,
  extensions: Puzzle,
  history: Activity,
  jobs: CalendarClock,
  projectSettings: Settings2,
};

/** Project destinations keep the working branch and environment in their links. */
export default function ProjectTabs({
  project,
  worktree,
  environment,
}: {
  project: string;
  worktree: string;
  environment: string;
}) {
  const t = useT();
  const route = usePageRoute();
  const active = route.area === "pipelines" ? route.tab : route.area;
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    navigation.current?.querySelector('[aria-current="page"]')?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [active]);
  return (
    <nav
      ref={navigation}
      className="tabs main-tabs"
      aria-label={t("projectNavigation")}
    >
      {([...workspaceTabs, "jobs", "projectSettings"] as const).map((tab) => {
        const Icon = icons[tab];
        return (
          <Link
            key={tab}
            to={
              tab === "jobs" || tab === "projectSettings"
                ? projectPageUrl(
                    project,
                    tab === "jobs" ? "jobs" : "settings/participants",
                    worktree,
                    environment,
                  )
                : worktreeUrl(worktree, tab, environment)
            }
            className={active === tab ? "active" : ""}
            aria-current={active === tab ? "page" : undefined}
          >
            <Icon size={15} aria-hidden="true" />
            {t(tab)}
          </Link>
        );
      })}
    </nav>
  );
}
