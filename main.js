(() => {
"use strict";
const { Settings, applyTheme } = window.LT;

function updateStatusPill() {
  const pill = document.getElementById("status-pill");
  if (navigator.onLine) { pill.classList.remove("offline"); pill.title = "Online"; }
  else { pill.classList.add("offline"); pill.title = "Offline — saved projects and reading still work."; }
}
window.addEventListener("online", updateStatusPill);
window.addEventListener("offline", updateStatusPill);
updateStatusPill();

// Apply stored display settings on load.
const s = Settings.get();
applyTheme(s.theme);
document.documentElement.style.setProperty("--reading-font-size", s.fontSize + "px");
document.documentElement.style.setProperty("--reading-line-height", s.lineSpacing);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  });
}

window.LT.UI.nav("home", {}, false);
})();
