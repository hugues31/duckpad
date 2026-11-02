import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Check, X } from "lucide-react";
import { useT } from "./i18n";

const TOAST_DURATION = 7000;

interface Message {
  text: string;
  error: boolean;
}

export function useToast() {
  const [message, setMessage] = useState<Message | null>(null);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), TOAST_DURATION);
    return () => clearTimeout(timer);
  }, [message]);
  const notify = useCallback(
    (text: string, error = false) => setMessage({ text, error }),
    [],
  );
  const dismiss = useCallback(() => setMessage(null), []);
  return { message, notify, dismiss };
}

export function Toast({
  message,
  onDismiss,
}: {
  message: Message | null;
  onDismiss: () => void;
}) {
  const t = useT();
  if (!message) return null;
  return (
    <div
      className={`toast ${message.error ? "error" : ""}`}
      role={message.error ? "alert" : "status"}
    >
      {message.error ? <AlertCircle size={17} /> : <Check size={17} />}
      <span>{message.text}</span>
      <button
        className="icon"
        title={t("close")}
        aria-label={t("close")}
        onClick={onDismiss}
      >
        <X size={15} />
      </button>
    </div>
  );
}
