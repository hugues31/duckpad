// Highlight the section being read in every table of contents of a guide.
const links = [
  ...document.querySelectorAll<HTMLAnchorElement>("[data-toc] a[href^='#']"),
];
const labels = document.querySelectorAll<HTMLElement>("[data-toc-current]");
const mobile = document.querySelector<HTMLDetailsElement>(".mobile-toc");

const idOf = (link: HTMLAnchorElement) => {
  try {
    return decodeURIComponent(link.hash.slice(1));
  } catch {
    return "";
  }
};
const targets = [...new Set(links.map(idOf))]
  .map((id) => document.getElementById(id))
  .filter((target): target is HTMLElement => target !== null)
  .sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );

let active: HTMLElement | undefined;
let pinned: HTMLElement | undefined;
let frame = 0;

function locate() {
  if (pinned) return pinned;
  const root = document.documentElement;
  const offset = parseFloat(getComputedStyle(root).scrollPaddingTop) || 0;
  const threshold = offset + Math.min(120, innerHeight * 0.2);
  let found = targets[0];
  for (const target of targets) {
    if (target.getBoundingClientRect().top > threshold) break;
    found = target;
  }
  // Short final sections never reach the top: at the end of the page, follow
  // the last heading the reader can see.
  if (scrollY > 0 && innerHeight + scrollY >= root.scrollHeight - 2) {
    for (const target of targets)
      if (target.getBoundingClientRect().top < innerHeight) found = target;
  }
  return found;
}

function keepInView(link: HTMLAnchorElement) {
  const list = link.closest<HTMLElement>("[data-toc]");
  if (!list || list.scrollHeight <= list.clientHeight) return;
  const top = link.offsetTop;
  if (
    top < list.scrollTop ||
    top + link.offsetHeight > list.scrollTop + list.clientHeight
  )
    list.scrollTop = top - list.clientHeight / 3;
}

function update() {
  frame = 0;
  const next = locate();
  if (next === active) return;
  active = next;
  let text = "";
  for (const link of links) {
    if (next && idOf(link) === next.id) {
      link.setAttribute("aria-current", "true");
      text ||= link.dataset.label || link.textContent?.trim() || "";
      keepInView(link);
    } else link.removeAttribute("aria-current");
  }
  labels.forEach((label) => (label.textContent = text));
}

const schedule = () => {
  frame ||= requestAnimationFrame(update);
};

if (targets.length) {
  for (const link of links)
    link.addEventListener("click", () => {
      // Keep the chosen section highlighted even if it cannot scroll to the top.
      pinned = document.getElementById(idOf(link)) ?? undefined;
      if (mobile) mobile.open = false;
      schedule();
    });
  for (const type of ["wheel", "touchstart", "keydown"])
    addEventListener(
      type,
      () => {
        if (!pinned) return;
        pinned = undefined;
        schedule();
      },
      { passive: true },
    );
  addEventListener("scroll", schedule, { passive: true });
  addEventListener("resize", schedule);
  update();
}

if (mobile) {
  mobile.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && mobile.open) {
      mobile.open = false;
      mobile.querySelector("summary")?.focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (mobile.open && !mobile.contains(event.target as Node))
      mobile.open = false;
  });
}
