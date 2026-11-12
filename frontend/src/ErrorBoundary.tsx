import { Component, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { useT } from "./i18n";

/** Replace a crashed interface with a recoverable message instead of a blank page. */
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <CrashMessage /> : this.props.children;
  }
}

function CrashMessage() {
  const t = useT();
  return (
    <div className="empty-state" role="alert">
      <AlertCircle size={32} />
      <h2>{t("unexpectedError")}</h2>
      <button
        className="button primary"
        onClick={() => window.location.reload()}
      >
        {t("reload")}
      </button>
    </div>
  );
}
