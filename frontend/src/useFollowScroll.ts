import { useLayoutEffect, useRef, useState } from "react";

/** Follow appended content until the reader scrolls away; restore their place on reopen. */
export function useFollowScroll<T extends HTMLElement>(
  open = true,
  distance = 48,
) {
  const log = useRef<T>(null);
  const followingRef = useRef(true);
  const readingAt = useRef(0);
  const [atEnd, setAtEnd] = useState(true);
  const restore = () => {
    const element = log.current;
    if (element)
      element.scrollTop = followingRef.current
        ? element.scrollHeight
        : readingAt.current;
  };
  useLayoutEffect(() => {
    if (open) restore();
  }, [open]);
  useLayoutEffect(() => {
    if (open && followingRef.current && log.current)
      log.current.scrollTop = log.current.scrollHeight;
  });
  const followLog = () => {
    const element = log.current;
    if (!element) return;
    followingRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <
      distance;
    readingAt.current = element.scrollTop;
    setAtEnd(followingRef.current);
  };
  const showLatest = () => {
    followingRef.current = true;
    log.current?.scrollTo({
      top: log.current.scrollHeight,
      behavior: "smooth",
    });
  };
  return { log, followingRef, atEnd, followLog, showLatest, restore };
}
