// Shared page-glue utilities used by index.html and compare.html.
// Dependency-free, runs on DOMContentLoaded / at load (both scripts use `defer` semantics
// by being placed at the end of <body>, so the DOM is ready).

(() => {
  "use strict";

  // ---------- Obfuscated mailto (runtime-assembled to dodge bot scrapers) ----------
  const emailEl = document.getElementById("authorEmail");
  if (emailEl) {
    const u = emailEl.dataset.user, d = emailEl.dataset.domain;
    if (u && d) {
      emailEl.addEventListener("click", (e) => {
        e.preventDefault();
        window.location.href = "mailto:" + u + "@" + d;
      });
      // Replace the obfuscated visible text with the real address once JS has run.
      emailEl.textContent = u + "@" + d;
    }
  }

  // ---------- Copy BibTeX ----------
  const copyBtn = document.getElementById("copyBibtex");
  const bibBlock = document.getElementById("bibtexBlock");
  if (copyBtn && bibBlock) {
    copyBtn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation(); // don't toggle the <details>
      const text = bibBlock.textContent || "";
      try {
        await navigator.clipboard.writeText(text);
      } catch (_) {
        // Fallback for older browsers
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); } catch (__) {}
        document.body.removeChild(ta);
      }
      const original = copyBtn.textContent;
      copyBtn.textContent = "Copied ✓";
      copyBtn.classList.add("copied");
      setTimeout(() => {
        copyBtn.textContent = original;
        copyBtn.classList.remove("copied");
      }, 1600);
    });
  }
})();
