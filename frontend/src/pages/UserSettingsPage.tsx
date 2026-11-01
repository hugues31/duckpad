import { useShell, useWorkspace } from "../shell";
import UserSettings from "../UserSettings";

export default function UserSettingsPage() {
  const { preferences, endSession } = useShell();
  return (
    <UserSettings
      onPasswordChanged={endSession}
      workspace={useWorkspace()}
      preferences={preferences}
    />
  );
}
