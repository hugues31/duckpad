import { Link } from "react-router";
import { AlertCircle, Loader2 } from "lucide-react";
import { useT } from "../i18n";
import { useShell } from "../shell";
import { useWorktree } from "../worktree";

export function PageLoading() {
  const t = useT();
  return (
    <div className="startup" role="status" aria-label={t("loading")}>
      <Loader2 className="spin" />
    </div>
  );
}

/** An unknown address, or a deleted or inaccessible resource. */
export function RouteError({ missing = false }: { missing?: boolean }) {
  const t = useT();
  return (
    <main className="empty-state" tabIndex={-1}>
      <AlertCircle size={32} />
      <h1>{t(missing ? "routeNotFound" : "routeUnavailable")}</h1>
      <p>{t(missing ? "routeNotFoundHint" : "routeUnavailableHint")}</p>
      <Link className="button primary" to="/projects">
        {t("backToProjects")}
      </Link>
    </main>
  );
}

export function NotFoundPage() {
  return <RouteError missing />;
}

/** A tab that needs the project files, while they cannot be read. */
export function InvalidProject() {
  const t = useT();
  const { openWorktree } = useShell();
  const { id } = useWorktree();
  return (
    <div className="empty-state">
      <AlertCircle size={32} />
      <h2>{t("invalid")}</h2>
      <p>{t("invalidHint")}</p>
      <button
        className="button primary"
        onClick={() => openWorktree(id, "code")}
      >
        {t("viewFiles")}
      </button>
    </div>
  );
}
