(function () {
  let boundForm = null;

  function serializeForm(form) {
    const state = {};

    for (const field of Array.from(form.elements)) {
      if (!field.name || field.disabled) {
        continue;
      }

      if (field.name === 'csrfToken' || field.name === 'guildName') {
        continue;
      }

      if (field.type === 'checkbox') {
        state[field.name] = field.checked ? '1' : '0';
        continue;
      }

      state[field.name] = field.value;
    }

    return JSON.stringify(state);
  }

  function snapshotCurrentValuesAsDefaults(form) {
    for (const field of Array.from(form.elements)) {
      if (!field.name) {
        continue;
      }

      if (field.type === 'checkbox') {
        field.defaultChecked = field.checked;
        continue;
      }

      field.defaultValue = field.value;
    }
  }

  function parseResponseError(response, fallbackMessage) {
    return response
      .json()
      .then(function (payload) {
        return payload && payload.error ? payload.error : fallbackMessage;
      })
      .catch(function () {
        return fallbackMessage;
      });
  }

  function init() {
    const form = document.querySelector('[data-settings-form]');
    const saveBar = document.querySelector('[data-save-bar]');
    const resetButton = document.querySelector('[data-reset-form]');
    const notice = document.querySelector('[data-auto-dismiss]');
    const saveButton = saveBar ? saveBar.querySelector('button[type="submit"]') : null;
    const ui = window.MOON_UI || {};

    if (notice) {
      ui.showToast?.(notice.textContent.trim(), 'success');
      notice.remove();
      if (window.history?.replaceState) {
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    }

    if (!form || !saveBar || boundForm === form) {
      return;
    }

    boundForm = form;
    let initialState = serializeForm(form);
    let isSaving = false;
    const defaultSaveLabel = saveButton ? saveButton.textContent : 'Save Changes';

    function syncDirtyState() {
      const isDirty = serializeForm(form) !== initialState;
      saveBar.classList.toggle('is-visible', isDirty && !isSaving);
    }

    function setSavingState(active) {
      isSaving = active;
      if (saveButton) {
        saveButton.classList.toggle('is-loading', active);
        saveButton.disabled = active;
        saveButton.textContent = active ? 'Saving...' : defaultSaveLabel;
      }
      if (resetButton) {
        resetButton.disabled = active;
      }
      ui.setPageLoading?.(active, active ? 'Saving changes...' : 'Loading...');
      saveBar.classList.toggle('is-visible', !active && serializeForm(form) !== initialState);
    }

    form.addEventListener('input', syncDirtyState);
    form.addEventListener('change', syncDirtyState);

    if (resetButton) {
      resetButton.addEventListener('click', function () {
        form.reset();
        syncDirtyState();
      });
    }

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (isSaving) {
        return;
      }

      setSavingState(true);

      try {
        const response = await fetch(form.action, {
          method: form.method || 'POST',
          headers: {
            Accept: 'application/json',
            'X-Requested-With': 'fetch',
          },
          body: new FormData(form),
        });

        if (!response.ok) {
          throw new Error(await parseResponseError(response, "Couldn't save settings."));
        }

        const payload = await response.json().catch(function () {
          return { ok: true, message: 'Settings saved.' };
        });
        snapshotCurrentValuesAsDefaults(form);
        initialState = serializeForm(form);
        syncDirtyState();
        ui.showToast?.(payload.message || 'Settings saved.', 'success');
      } catch (error) {
        ui.showToast?.(error.message || "Couldn't save settings.", 'error');
      } finally {
        setSavingState(false);
      }
    });

    syncDirtyState();
  }

  window.MOON_GUILD_SETTINGS = {
    init,
  };
})();
