import { useEffect, useRef, useState } from "react";
import { Check, LogOut, Settings2 } from "lucide-react";
import { useT, type Language } from "./i18n";

export default function AccountMenu({
  theme,
  language,
  setTheme,
  setLanguage,
  onSettings,
  onSignOut,
}: {
  theme: string;
  language: Language;
  setTheme: (value: string) => void;
  setLanguage: (value: Language) => void;
  onSettings: () => void;
  onSignOut: () => void;
}) {
  const t = useT();
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
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
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
        A
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
              ...menu.current!.querySelectorAll<HTMLButtonElement>("button"),
            ];
            const current = items.indexOf(
              document.activeElement as HTMLButtonElement,
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
          <div role="group" aria-label={t("language")}>
            <span className="account-menu-label">{t("language")}</span>
            <div className="account-options">
              {(["en", "fr"] as const).map((value) => (
                <button
                  key={value}
                  role="menuitemradio"
                  tabIndex={-1}
                  aria-checked={language === value}
                  onClick={() => {
                    setLanguage(value);
                    close();
                  }}
                >
                  {t(value === "en" ? "english" : "french")}
                  {language === value && <Check size={13} />}
                </button>
              ))}
            </div>
          </div>
          <div role="group" aria-label={t("theme")}>
            <span className="account-menu-label">{t("theme")}</span>
            <div className="account-options">
              {["light", "dark"].map((value) => (
                <button
                  key={value}
                  role="menuitemradio"
                  tabIndex={-1}
                  aria-checked={theme === value}
                  onClick={() => {
                    setTheme(value);
                    close();
                  }}
                >
                  {t(value)}
                  {theme === value && <Check size={13} />}
                </button>
              ))}
            </div>
          </div>
          <div className="account-actions">
            <button
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                close();
                onSettings();
              }}
            >
              <Settings2 size={16} />
              {t("settings")}
            </button>
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
