import { api, send } from "./api";
import { useT } from "./i18n";
import { useAsyncAction } from "./useAsyncAction";

/** Change the signed-in user's password. */
export default function PasswordForm({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const { pending, error, run } = useAsyncAction();
  return (
    <div className="settings-card">
      <h2>{t("changePassword")}</h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const changed = await run(() =>
            api(
              "/password",
              send({
                current: data.get("current"),
                password: data.get("password"),
              }),
            ),
          );
          if (changed) onChanged();
        }}
      >
        <label className="field">
          <span>{t("currentPassword")}</span>
          <input
            name="current"
            type="password"
            required
            autoComplete="current-password"
          />
        </label>
        <label className="field">
          <span>{t("newPassword")}</span>
          <input
            aria-label={t("newPassword")}
            name="password"
            type="password"
            required
            minLength={12}
            maxLength={1024}
            autoComplete="new-password"
          />
          <small>{t("passwordChangeHint")}</small>
        </label>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary" disabled={pending}>
          {t("changePassword")}
        </button>
      </form>
    </div>
  );
}
