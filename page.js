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
  // ---------- Page view counter (visitorbadge.io — free, no signup) ----------
  // All pages share one counter by using the *same* `path` URL in the badge.
  // To make sure every page load is actually counted (and not served from the
  // browser's HTTP cache because index/compare/models.html have the exact same
  // badge URL), we append a per-load cache-buster query param. `path=...` is
  // what visitorbadge.io uses to identify the counter, so this extra param
  // does not fragment the count.
  try {
    const badge = document.querySelector('.view-counter img');
    if (badge && badge.src && badge.src.indexOf('visitorbadge.io') !== -1) {
      const sep = badge.src.indexOf('?') === -1 ? '?' : '&';
      badge.src = badge.src + sep + '_=' + Date.now();
    }
  } catch (e) { /* non-fatal: leave the cached badge in place */ }
})();
