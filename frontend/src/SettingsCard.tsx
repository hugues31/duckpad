import type { ReactNode } from "react";
import { useT } from "./i18n";

export default function SettingsCard({
  title,
  description,
  error,
  loading,
  children,
  level = 2,
}: {
  title: string;
  description: string;
  error: string;
  loading: boolean;
  children: ReactNode;
  level?: 2 | 3;
}) {
  const t = useT();
  const Heading = level === 3 ? "h3" : "h2";
  return (
    <section className="settings-card" aria-label={title}>
      <Heading>{title}</Heading>
      <p className="muted">{description}</p>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {loading ? <p>{t("loading")}</p> : children}
    </section>
  );
}
