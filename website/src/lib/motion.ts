const motion = matchMedia("(prefers-reduced-motion: reduce)");

// Animate milestones in a guide without delaying its reading text.
document
  .querySelectorAll<HTMLElement>(
    ".prose > h2, .prose > h3, .prose > pre, .prose > table, .prose > p:has(> img), .doc-bottom",
  )
  .forEach((element) => {
    element.dataset.reveal = element.querySelector("img") ? "media" : "";
  });

const elements = [...document.querySelectorAll<HTMLElement>("[data-reveal]")];
let observer: IntersectionObserver | undefined;

function reveal(element: HTMLElement, immediate = false) {
  if (immediate) element.dataset.revealImmediate = "";
  delete element.dataset.revealPending;
  observer?.unobserve(element);
}

function revealAnchor() {
  let target: HTMLElement | null;
  try {
    target = document.getElementById(
      decodeURIComponent(location.hash.slice(1)),
    );
  } catch {
    return;
  }
  const element = target?.closest<HTMLElement>("[data-reveal]");
  if (element) reveal(element, true);
}

function setup() {
  observer?.disconnect();
  elements.forEach((element) => reveal(element, true));
  if (motion.matches || !("IntersectionObserver" in window)) return;

  observer = new IntersectionObserver(
    (entries) => {
      const groups = new Map<Element | null, number>();
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const element = entry.target as HTMLElement;
        if (element.matches(".feature-card, .workflow-item")) {
          const index = groups.get(element.parentElement) || 0;
          element.style.setProperty(
            "--reveal-delay",
            `${Math.min(index, 3) * 90}ms`,
          );
          groups.set(element.parentElement, index + 1);
        }
        reveal(element);
      }
    },
    { rootMargin: "0px 0px -32px 0px" },
  );
  elements.forEach((element) => {
    // Preserve the initial viewport, restored scroll positions and keyboard focus.
    if (
      element.getBoundingClientRect().top >= innerHeight &&
      !element.matches(":focus-within")
    ) {
      delete element.dataset.revealImmediate;
      element.dataset.revealPending = "";
      observer!.observe(element);
    }
  });
  revealAnchor();
}

elements.forEach((element) => {
  element.addEventListener("focusin", () => reveal(element, true));
});
window.addEventListener("hashchange", revealAnchor);
motion.addEventListener("change", setup);
setup();
