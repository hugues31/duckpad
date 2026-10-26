import { Component, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import en from "./locales/en.json";
import fr from "./locales/fr.json";
import { I18n } from "./i18n";

/** Replace a crashed interface with a recoverable message instead of a blank page. */
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  static contextType = I18n;
  declare context: React.ContextType<typeof I18n>;
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const messages = this.context.language === "fr" ? fr : en;
    return (
      <div className="empty-state" role="alert">
        <AlertCircle size={32} />
        <h2>{messages.unexpectedError}</h2>
        <button
          className="button primary"
          onClick={() => window.location.reload()}
        >
          {messages.reload}
        </button>
      </div>
    );
  }
}
