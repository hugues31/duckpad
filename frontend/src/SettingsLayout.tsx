import { useId, type Key, type ReactNode } from "react";
import { useT } from "./i18n";

export default function SettingsLayout({
  title,
  eyebrow,
  description,
  navigation,
  children,
  badge,
  className = "",
  contentKey,
}: {
  title: string;
  eyebrow: string;
  description: string;
  navigation: ReactNode;
  children: ReactNode;
  badge?: ReactNode;
  className?: string;
  /** Remounts the content, such as when another section opens. */
  contentKey?: Key;
}) {
  const t = useT();
  const heading = useId();
  return (
    <section
      className={`full-panel instance-settings ${className}`}
      aria-labelledby={heading}
    >
      <div className="settings-container">
        <header className="settings-heading">
          <span className="eyebrow">{eyebrow}</span>
          <h1 id={heading}>{title}</h1>
          <p className="muted">{description}</p>
          {badge}
        </header>
        <div className="settings-layout">
          <nav
            className="settings-navigation"
            aria-label={t("settingsSections")}
          >
            {navigation}
          </nav>
          <div className="settings-content" key={contentKey}>
            {children}
          </div>
        </div>
      </div>
    </section>
  );
}
