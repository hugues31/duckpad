import { useCallback, useRef, useState } from "react";

/** Track the pending state and error message of a user-triggered async action. */
export function useAsyncAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const run = useCallback(async (action: () => Promise<unknown>) => {
    if (running.current) return false;
    running.current = true;
    setPending(true);
    setError("");
    try {
      await action();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      running.current = false;
      setPending(false);
    }
  }, []);
  return { pending, error, setError, run };
}
