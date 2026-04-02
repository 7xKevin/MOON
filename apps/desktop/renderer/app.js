(function () {
  async function boot() {
    const api = window.MOON_DESKTOP;
    const context = await api.getShellContext();
    const triggers = Array.from(document.querySelectorAll('[data-view-trigger]'));
    const views = Array.from(document.querySelectorAll('[data-view]'));

    function setActiveView(viewName) {
      triggers.forEach((trigger) => {
        trigger.classList.toggle('is-active', trigger.dataset.viewTrigger === viewName);
      });
      views.forEach((view) => {
        view.classList.toggle('is-active', view.dataset.view === viewName);
      });
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

      if (action === 'open-downloads') {
        api.openExternal(context.webUrl + '/dashboard');
        return;
      }

      if (action === 'open-website') {
        api.openExternal(context.webUrl);
      }
    });

    setActiveView('overview');
  }

  boot().catch((error) => {
    console.error('[MOON Desktop] Failed to boot renderer.', error);
  });
})();
