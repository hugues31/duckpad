import type { ReactNode } from "react";

export default function SettingsLayout({
  title,
  eyebrow,
  description,
  navigation,
  children,
  badge,
  className = "",
}: {
  title: string;
  eyebrow: string;
  description: string;
  navigation: ReactNode;
  children: ReactNode;
  badge?: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`full-panel instance-settings ${className}`}
      aria-label={title}
    >
      <div className="settings-container">
        <header className="settings-heading">
          <span className="eyebrow">{eyebrow}</span>
          <h1>{title}</h1>
          <p className="muted">{description}</p>
          {badge}
        </header>
        <div className="settings-layout">
          <nav className="settings-navigation" aria-label={title}>
            {navigation}
          </nav>
          <div className="settings-content">{children}</div>
        </div>
      </div>
    </section>
  );
}
