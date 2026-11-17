import { Plus, X } from "lucide-react";
import { useState } from "react";
import { api, send } from "./api";
import { useT } from "./i18n";
import Select from "./Select";
import SettingsCard from "./SettingsCard";
import { useResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";
import { useSettingsForm } from "./useSettingsForm";

interface Destination {
  id?: string;
  name: string;
  kind: "email" | "webhook";
  recipients?: string[];
  /** The host of the saved URL; the URL itself is never returned. */
  url_host?: string;
  /** A new URL, sent once and never shown again. */
  url?: string;
}

interface Configuration {
  smtp: {
    host: string;
    port: number;
    security: "starttls" | "tls" | "none";
    username: string;
    sender: string;
    has_password: boolean;
    /** A new password, sent once and never shown again. */
    password?: string;
  };
  destinations: Destination[];
}

export default function NotificationSettings() {
  const t = useT();
  const resource = useResource("/notification-settings", (signal) =>
    api<Configuration>("/notification-settings", { signal }),
  );
  const test = useAsyncAction();
  const [tested, setTested] = useState<string | null>(null);
  const { config, change, pending, saved, submit, error } = useSettingsForm(
    resource.data,
    async (config) => {
      const { has_password: _saved, password, ...smtp } = config.smtp;
      const value = await api<Configuration>(
        "/notification-settings",
        send(
          {
            smtp: { ...smtp, password: password || undefined },
            destinations: config.destinations.map(
              ({ url_host: _host, url, recipients, ...item }) => ({
                ...item,
                ...(item.kind === "email"
                  ? { recipients: (recipients || []).filter(Boolean) }
                  : { url: url || undefined }),
              }),
            ),
          },
          "PUT",
        ),
      );
      resource.setData(value);
    },
  );
  const smtp = config?.smtp;
  const destinations = config?.destinations || [];
  const setSmtp = (changes: Partial<Configuration["smtp"]>) =>
    change({ smtp: { ...smtp!, ...changes } });
  const setDestination = (index: number, changes: Partial<Destination>) =>
    change({
      destinations: destinations.map((item, i) =>
        i === index ? { ...item, ...changes } : item,
      ),
    });
  return (
    <SettingsCard
      title={t("notifications")}
      description={t("notificationSettingsDescription")}
      error={error || resource.error || test.error}
      loading={!config}
    >
      {config && smtp && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={pending} className="notification-fields">
            <h3>{t("smtpServer")}</h3>
            <div className="settings-fields">
              <label className="field">
                <span>{t("smtpHost")}</span>
                <input
                  placeholder="smtp.example.com"
                  value={smtp.host}
                  onChange={(e) => setSmtp({ host: e.target.value })}
                />
              </label>
              <label className="field">
                <span>{t("smtpPort")}</span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={smtp.port}
                  onChange={(e) => setSmtp({ port: Number(e.target.value) })}
                />
              </label>
              <label className="field">
                <span>{t("smtpSecurity")}</span>
                <Select
                  aria-label={t("smtpSecurity")}
                  value={smtp.security}
                  onChange={(e) =>
                    setSmtp({
                      security: e.target
                        .value as Configuration["smtp"]["security"],
                    })
                  }
                >
                  <option value="starttls">STARTTLS</option>
                  <option value="tls">TLS</option>
                  <option value="none">{t("smtpNoEncryption")}</option>
                </Select>
              </label>
              <label className="field">
                <span>{t("smtpSender")}</span>
                <input
                  type="email"
                  placeholder="duckpad@example.com"
                  value={smtp.sender}
                  onChange={(e) => setSmtp({ sender: e.target.value })}
                />
              </label>
              <label className="field">
                <span>{t("username")}</span>
                <input
                  autoComplete="off"
                  value={smtp.username}
                  onChange={(e) => setSmtp({ username: e.target.value })}
                />
              </label>
              <label className="field">
                <span>{t("password")}</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  aria-describedby="smtp-password-hint"
                  value={smtp.password || ""}
                  onChange={(e) => setSmtp({ password: e.target.value })}
                />
                <small className="muted" id="smtp-password-hint">
                  {t(
                    smtp.has_password
                      ? "smtpPasswordSaved"
                      : "smtpPasswordHint",
                  )}
                </small>
              </label>
            </div>
            <h3>{t("notificationDestinations")}</h3>
            <p className="muted">{t("notificationDestinationsHint")}</p>
            {destinations.map((item, index) => (
              <div className="destination-row" key={item.id || `new-${index}`}>
                <input
                  aria-label={t("destinationName")}
                  placeholder={t("destinationName")}
                  required
                  maxLength={80}
                  value={item.name}
                  onChange={(e) =>
                    setDestination(index, { name: e.target.value })
                  }
                />
                <Select
                  aria-label={t("destinationKind")}
                  value={item.kind}
                  onChange={(e) =>
                    setDestination(index, {
                      kind: e.target.value as Destination["kind"],
                    })
                  }
                >
                  <option value="email">{t("destinationEmail")}</option>
                  <option value="webhook">{t("destinationWebhook")}</option>
                </Select>
                {item.kind === "email" ? (
                  <input
                    aria-label={t("destinationRecipients")}
                    placeholder="ops@example.com, data@example.com"
                    required
                    value={(item.recipients || []).join(", ")}
                    onChange={(e) =>
                      setDestination(index, {
                        recipients: e.target.value
                          .split(",")
                          .map((value) => value.trim()),
                      })
                    }
                  />
                ) : (
                  <input
                    aria-label={t("destinationUrl")}
                    type="password"
                    autoComplete="off"
                    required={!item.url_host}
                    placeholder={
                      item.url_host
                        ? t("destinationUrlSaved").replace(
                            "{host}",
                            item.url_host,
                          )
                        : "https://hooks.example.com/…"
                    }
                    value={item.url || ""}
                    onChange={(e) =>
                      setDestination(index, { url: e.target.value })
                    }
                  />
                )}
                <button
                  type="button"
                  className="button secondary small"
                  disabled={!item.id || test.pending}
                  title={item.id ? undefined : t("destinationTestAfterSave")}
                  onClick={() => {
                    setTested(null);
                    void test.run(async () => {
                      await api(
                        "/notification-settings/test",
                        send({ destination: item.id }),
                      );
                      setTested(item.name);
                    });
                  }}
                >
                  {t("destinationTest")}
                </button>
                <button
                  type="button"
                  className="icon"
                  aria-label={t("removeDestination")}
                  title={t("removeDestination")}
                  onClick={() =>
                    change({
                      destinations: destinations.filter((_, i) => i !== index),
                    })
                  }
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            <div className="row gap">
              <button
                type="button"
                className="button secondary small"
                onClick={() =>
                  change({
                    destinations: [
                      ...destinations,
                      { name: "", kind: "webhook" },
                    ],
                  })
                }
              >
                <Plus size={14} />
                {t("addDestination")}
              </button>
            </div>
            <button className="button primary">
              {t(pending ? "saving" : "save")}
            </button>
          </fieldset>
          {saved && <p role="status">{t("notificationSettingsSaved")}</p>}
          {tested && !test.pending && (
            <p role="status">
              {t("destinationTestSent").replace("{name}", tested)}
            </p>
          )}
        </form>
      )}
    </SettingsCard>
  );
}
