(function () {
  function serializeForm(form) {
    const state = {};

    for (const field of Array.from(form.elements)) {
      if (!field.name || field.disabled) {
        continue;
      }

      if (field.name === "csrfToken" || field.name === "guildName") {
        continue;
      }

      if (field.type === "checkbox") {
        state[field.name] = field.checked ? "1" : "0";
        continue;
      }

      state[field.name] = field.value;
    }

    return JSON.stringify(state);
  }

  document.addEventListener("DOMContentLoaded", function () {
    const form = document.querySelector("[data-settings-form]");
    const saveBar = document.querySelector("[data-save-bar]");
    const resetButton = document.querySelector("[data-reset-form]");
    const notice = document.querySelector("[data-auto-dismiss]");

    if (notice) {
      window.setTimeout(function () {
        notice.classList.add("is-hidden");
        if (window.history?.replaceState) {
          window.history.replaceState({}, document.title, window.location.pathname);
        }
      }, 2200);
    }

    if (!form || !saveBar) {
      return;
    }

    const initialState = serializeForm(form);

    function syncDirtyState() {
      const isDirty = serializeForm(form) !== initialState;
      saveBar.classList.toggle("is-visible", isDirty);
    }

    form.addEventListener("input", syncDirtyState);
    form.addEventListener("change", syncDirtyState);

    if (resetButton) {
      resetButton.addEventListener("click", function () {
        form.reset();
        syncDirtyState();
      });
    }

    syncDirtyState();
  });
})();
