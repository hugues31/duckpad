import SettingsLayout from "./SettingsLayout";
import { NavLink } from "react-router";
import {
  Blocks,
  Cpu,
  MessageSquare,
  Database,
  GitBranch,
  KeyRound,
  Server,
  Users,
} from "lucide-react";
import { settingsSections } from "./navigation";
import AssistantSettings from "./AssistantSettings";
import UsersPage from "./UsersPage";
import ConnectionsPanel from "./ConnectionsPanel";
import EnvironmentsPanel from "./EnvironmentsPanel";
import ExtensionSettings from "./ExtensionSettings";
import GitHostsSettings from "./GitHostsSettings";
import { useT } from "./i18n";
import SQLResourceSettings from "./SQLResourceSettings";
import SSOSettings from "./SSOSettings";
import type { ConnectorEditor, Workspace } from "./types";

const sectionIcons = {
  usersPermissions: Users,
  assistant: MessageSquare,
  ssoSettings: KeyRound,
  gitHosts: GitBranch,
  environments: Server,
  connections: Database,
  extensions: Blocks,
  sqlResources: Cpu,
};

export default function InstanceSettings({
  section,
  workspace,
  refresh,
  onConnectorEditor,
}: {
  section: string;
  workspace: Workspace;
  refresh: () => Promise<void>;
  onConnectorEditor: (editor: ConnectorEditor) => void;
}) {
  const t = useT();
  return (
    <SettingsLayout
      title={t("instanceSettings")}
      eyebrow={t("instance")}
      description={t("instanceSettingsDescription")}
      contentKey={section}
      navigation={settingsSections.map(([slug, key]) => {
        const Icon = sectionIcons[key];
        return (
          <NavLink
            to={`/instance-settings/${slug}`}
            end
            key={key}
            className={section === key ? "active" : ""}
            aria-current={section === key ? "page" : undefined}
          >
            <Icon size={18} aria-hidden="true" />
            <span>{t(key)}</span>
          </NavLink>
        );
      })}
    >
      {section === "usersPermissions" && <UsersPage refresh={refresh} />}
      {section === "assistant" && <AssistantSettings />}
      {section === "extensions" && <ExtensionSettings />}
      {section === "sqlResources" && <SQLResourceSettings />}
      {section === "ssoSettings" && <SSOSettings />}
      {section === "gitHosts" && <GitHostsSettings />}
      {section === "environments" && (
        <EnvironmentsPanel
          environments={workspace.catalog.environment_details}
          refresh={refresh}
        />
      )}
      {section === "connections" && (
        <ConnectionsPanel
          workspace={workspace}
          refresh={refresh}
          onEditor={onConnectorEditor}
        />
      )}
    </SettingsLayout>
  );
}
