import { Bot, User } from "lucide-react";
import { useT } from "./i18n";
import type { Run } from "./types";

/** Who asked for a run: a person, or a service account named as such. */
export default function RunRequester({
  requester,
}: {
  requester: Run["requester"];
}) {
  const t = useT();
  if (!requester) return null;
  const Icon = requester.service ? Bot : User;
  return (
    <span
      className="run-requester"
      title={`${t("runRequester")}: ${requester.username}`}
    >
      <Icon size={12} aria-hidden="true" />
      {requester.username}
      {requester.service && (
        <span className="run-requester-kind">{t("serviceAccount")}</span>
      )}
    </span>
  );
}
