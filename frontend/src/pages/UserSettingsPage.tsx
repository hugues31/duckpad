import { useShell, useWorkspace } from "../shell";
import UserSettings from "../UserSettings";
import { usePageRoute } from "../navigation";

export default function UserSettingsPage() {
  const { preferences, endSession } = useShell();
  const { section } = usePageRoute();
  return (
    <UserSettings
      section={section}
      onPasswordChanged={endSession}
      workspace={useWorkspace()}
      preferences={preferences}
    />
  );
}
