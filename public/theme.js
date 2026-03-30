(function () {
  const root = document.documentElement;
  const storageKey = "moon-theme";
  const preferredDark =
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    const label = document.querySelector("[data-theme-label]");
    if (label) {
      label.textContent = theme === "dark" ? "Dark" : "Light";
    }
  }

  const savedTheme = localStorage.getItem(storageKey);
  applyTheme(savedTheme || (preferredDark ? "dark" : "light"));

  document.addEventListener("click", function (event) {
    const toggle = event.target.closest("[data-theme-toggle]");
    if (!toggle) {
      return;
    }

    const nextTheme =
      root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    localStorage.setItem(storageKey, nextTheme);
    applyTheme(nextTheme);
  });
})();
