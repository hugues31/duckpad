// Give every code block a copy button. The button sits in a wrapper beside the
// block, not inside it: a long line scrolls the code horizontally, and an
// absolutely positioned child of the scroller would scroll away with it.
document.querySelectorAll<HTMLElement>("pre").forEach((pre) => {
  const code = pre.querySelector("code");
  if (!code) return;
  const block = document.createElement("div");
  block.className = "code-block";
  pre.before(block);
  block.append(pre);
  const button = document.createElement("button");
  button.className = "copy-code";
  button.textContent = "Copy";
  button.setAttribute("aria-label", "Copy code");
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code.textContent || "");
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select to copy";
    }
    setTimeout(() => {
      button.textContent = "Copy";
    }, 2000);
  });
  block.append(button);
});
