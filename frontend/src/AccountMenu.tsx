import { Link } from "react-router";
import { useEffect, useRef, useState } from "react";
import { Check, LogOut, Settings2 } from "lucide-react";
import { useT } from "./i18n";
import { usePreferenceChoices, type Preferences } from "./preferences";

export default function AccountMenu({
  username,
  preferences,
  onSignOut,
}: {
  username: string;
  preferences: Preferences;
  onSignOut: () => void;
}) {
  const t = useT();
  const choices = usePreferenceChoices(preferences);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div className="account" ref={root}>
      <button
        ref={trigger}
        className="avatar"
        title={t("accountMenu")}
        aria-label={t("accountMenu")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="account-menu"
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {username.slice(0, 1).toUpperCase()}
      </button>
      {open && (
        <div
          ref={menu}
          id="account-menu"
          className="account-menu"
          role="menu"
          aria-label={t("accountMenu")}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
            if (event.key === "Tab") close();
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const items = [
              ...menu.current!.querySelectorAll<HTMLElement>(
                '[role^="menuitem"]',
              ),
            ];
            const current = items.indexOf(
              document.activeElement as HTMLElement,
            );
            const index =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (current +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      items.length) %
                    items.length;
            items[index].focus();
          }}
        >
          {choices.map((choice) => (
            <div key={choice.name} role="group" aria-label={choice.label}>
              <span className="account-menu-label">{choice.label}</span>
              <div className="account-options">
                {choice.options.map(({ value, label }) => (
                  <button
                    key={value}
                    role="menuitemradio"
                    tabIndex={-1}
                    aria-checked={choice.value === value}
                    onClick={() => {
                      choice.choose(value);
                      close();
                    }}
                  >
                    {label}
                    {choice.value === value && <Check size={13} />}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="account-actions">
            <Link
              to="/user-settings"
              role="menuitem"
              tabIndex={-1}
              onClick={close}
            >
              <Settings2 size={16} />
              {t("userSettings")}
            </Link>
            <button
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                close();
                onSignOut();
              }}
            >
              <LogOut size={16} />
              {t("signOut")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
