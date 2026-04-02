(function () {
  async function boot() {
    const api = window.MOON_DESKTOP;
    const context = await api.getShellContext();
    const triggers = Array.from(document.querySelectorAll('[data-view-trigger]'));
    const views = Array.from(document.querySelectorAll('[data-view]'));
    const updateBanner = document.querySelector('[data-update-banner]');
    const updateTitle = document.querySelector('[data-update-title]');
    const updateCopy = document.querySelector('[data-update-copy]');

    function setActiveView(viewName) {
      triggers.forEach((trigger) => {
        trigger.classList.toggle('is-active', trigger.dataset.viewTrigger === viewName);
      });
      views.forEach((view) => {
        view.classList.toggle('is-active', view.dataset.view === viewName);
      });
    }

    async function refreshUpdateState() {
      if (!updateBanner || !updateTitle || !updateCopy) {
        return;
      }

      const result = await api.checkForUpdates();
      updateBanner.hidden = false;

      if (!result.ok) {
        updateTitle.textContent = 'Update check unavailable';
        updateCopy.textContent = 'The desktop app could not reach the MOON website release feed right now.';
        return;
      }

      if (result.hasUpdate) {
        updateTitle.textContent = 'New desktop update available';
        updateCopy.textContent = 'Version ' + result.remoteVersion + ' is available. Open the MOON website in this window to update.';
        return;
      }

      updateTitle.textContent = 'Desktop app is up to date';
      updateCopy.textContent = 'You are running version ' + result.currentVersion + '. The app will keep checking the website release feed.';
    }

    triggers.forEach((trigger) => {
      trigger.addEventListener('click', function () {
        setActiveView(trigger.dataset.viewTrigger);
      });
    });

    document.addEventListener('click', function (event) {
      const actionButton = event.target.closest('[data-action]');
      if (!actionButton) {
        return;
      }

      const action = actionButton.dataset.action;
      if (action === 'open-dashboard') {
        api.openDashboard('/dashboard');
        return;
      }

      if (action === 'open-website') {
        api.navigateMain('/');
      }
    });

    setActiveView('overview');
    refreshUpdateState();
    window.setInterval(refreshUpdateState, 1000 * 60 * 30);
  }

  boot().catch((error) => {
    console.error('[MOON Desktop] Failed to boot renderer.', error);
  });
})();
