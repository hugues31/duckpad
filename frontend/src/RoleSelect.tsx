import Select from "./Select";
import { useT } from "./i18n";

const INSTANCE_ROLES = ["member", "admin"] as const;
export const PROJECT_ROLES = ["reader", "editor", "admin"] as const;

/** Choose an instance role, or a project role by default. */
export default function RoleSelect({
  value,
  onChange,
  instance = false,
  disabled = false,
  label,
}: {
  value: string;
  onChange: (role: string) => void;
  instance?: boolean;
  disabled?: boolean;
  label: string;
}) {
  const t = useT();
  return (
    <Select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {(instance ? INSTANCE_ROLES : PROJECT_ROLES).map((role) => (
        <option key={role} value={role}>
          {t(`role_${role}`)}
        </option>
      ))}
    </Select>
  );
}
