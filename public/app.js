(function () {
  let navigationInFlight = false;
  let modalLastFocused = null;

  function ensureToastStack() {
    let stack = document.querySelector('[data-toast-stack]');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'toast-stack';
      stack.setAttribute('data-toast-stack', 'true');
      document.body.appendChild(stack);
    }
    return stack;
  }

  function showToast(message, type) {
    if (!message) {
      return;
    }

    const stack = ensureToastStack();
    const toast = document.createElement('div');
    toast.className = 'toast ' + (type || 'success');
    toast.textContent = message;
    stack.appendChild(toast);

    requestAnimationFrame(function () {
      toast.classList.add('is-visible');
    });

    window.setTimeout(function () {
      toast.classList.remove('is-visible');
      window.setTimeout(function () {
        toast.remove();
      }, 220);
    }, 2600);
  }

  function ensurePageLoader() {
    let loader = document.querySelector('[data-page-loader]');
    if (!loader) {
      loader = document.createElement('div');
      loader.className = 'page-loader';
      loader.setAttribute('data-page-loader', 'true');
      loader.innerHTML = '<div class="page-loader-card"><span class="loader-spinner"></span><span class="loader-label">Loading...</span></div>';
      document.body.appendChild(loader);
    }
    return loader;
  }

  function setPageLoading(active, label) {
    const loader = ensurePageLoader();
    const labelNode = loader.querySelector('.loader-label');
    if (labelNode && label) {
      labelNode.textContent = label;
    }
    loader.classList.toggle('is-visible', Boolean(active));
  }

  function getCommandModal() {
    return document.querySelector('[data-command-modal]');
  }

  function getCommandModalSheet() {
    return document.querySelector('[data-command-modal] .modal-sheet');
  }

  function getModalFocusableElements() {
    const modal = getCommandModal();
    if (!modal) {
      return [];
    }

    return Array.from(
      modal.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter(function (element) {
      return !element.hidden && element.offsetParent !== null;
    });
  }

  function closeCommandModal() {
    const modal = getCommandModal();
    if (!modal) {
      return;
    }

    modal.classList.remove('is-visible');
    document.body.classList.remove('modal-open');
    window.setTimeout(function () {
      if (!modal.classList.contains('is-visible')) {
        modal.hidden = true;
      }
    }, 180);

    if (modalLastFocused && typeof modalLastFocused.focus === 'function') {
      modalLastFocused.focus();
    }
    modalLastFocused = null;
  }

  function openCommandModal() {
    const modal = getCommandModal();
    if (!modal) {
      return;
    }

    modalLastFocused = document.activeElement;
    modal.hidden = false;
    requestAnimationFrame(function () {
      modal.classList.add('is-visible');
      document.body.classList.add('modal-open');
      const firstFocusable = getModalFocusableElements()[0] || getCommandModalSheet();
      firstFocusable?.focus?.();
    });
  }

  function runPageInitializers() {
    window.MOON_THEME?.init?.();
    window.MOON_GUILD_SETTINGS?.init?.();
  }

  function markPageReady() {
    requestAnimationFrame(function () {
      document.body.classList.add('page-ready');
      document.body.classList.remove('page-leaving');
    });
  }

  function isPlainPrimaryClick(event) {
    return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  }

  function shouldHandleLink(link) {
    if (!link || link.target || link.hasAttribute('download')) {
      return false;
    }

    const href = link.getAttribute('href');
    if (!href || href.startsWith('#')) {
      return false;
    }

    try {
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) {
        return false;
      }

      if (url.pathname === '/login' || url.pathname === '/logout' || url.pathname.startsWith('/auth/')) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  async function fetchDocument(url) {
    const response = await fetch(url, {
      headers: {
        'X-Requested-With': 'navigation',
      },
      credentials: 'same-origin',
    });

    if (!response.ok) {
      throw new Error('Navigation failed.');
    }

    const html = await response.text();
    const parser = new DOMParser();
    return parser.parseFromString(html, 'text/html');
  }

  function syncBodyState(nextDocument) {
    document.body.className = nextDocument.body.className || '';
    document.body.classList.remove('page-ready', 'page-leaving', 'modal-open');
  }

  async function ensureDocumentScripts(nextDocument) {
    const nextScripts = Array.from(nextDocument.querySelectorAll('script[src]'));

    for (const nextScript of nextScripts) {
      const source = new URL(nextScript.getAttribute('src'), window.location.href).href;
      const existing = Array.from(document.querySelectorAll('script[src]')).some(function (script) {
        return new URL(script.getAttribute('src'), window.location.href).href === source;
      });

      if (existing) {
        continue;
      }

      await new Promise(function (resolve, reject) {
        const script = document.createElement('script');
        script.src = source;
        if (nextScript.defer) {
          script.defer = true;
        }
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }
  }

  async function replacePageContent(nextDocument) {
    const nextLayout = nextDocument.querySelector('.layout');
    const currentLayout = document.querySelector('.layout');

    if (!nextLayout || !currentLayout) {
      throw new Error('Could not update page layout.');
    }

    closeCommandModal();
    document.title = nextDocument.title;
    syncBodyState(nextDocument);
    currentLayout.replaceWith(nextLayout);
    await ensureDocumentScripts(nextDocument);
    runPageInitializers();
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    markPageReady();
  }

  async function navigateTo(url, options) {
    if (navigationInFlight) {
      return;
    }

    const settings = Object.assign({ pushState: true, label: 'Opening...' }, options || {});
    navigationInFlight = true;
    document.body.classList.add('page-leaving');
    setPageLoading(true, settings.label);

    try {
      const nextDocument = await fetchDocument(url);
      await replacePageContent(nextDocument);
      if (settings.pushState) {
        window.history.pushState({}, '', url);
      }
    } catch (error) {
      window.location.href = url;
      return;
    } finally {
      navigationInFlight = false;
      setPageLoading(false);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    runPageInitializers();
    markPageReady();
  });

  window.addEventListener('pageshow', function () {
    runPageInitializers();
    markPageReady();
    setPageLoading(false);
  });

  window.addEventListener('popstate', function () {
    navigateTo(window.location.href, { pushState: false, label: 'Loading...' });
  });

  document.addEventListener('click', function (event) {
    const openButton = event.target.closest('[data-command-modal-open]');
    if (openButton) {
      event.preventDefault();
      openCommandModal();
      return;
    }

    const closeButton = event.target.closest('[data-command-modal-close]');
    const modal = event.target.closest('[data-command-modal]');
    if (closeButton || (modal && event.target === modal)) {
      event.preventDefault();
      closeCommandModal();
      return;
    }

    const link = event.target.closest('a');
    if (!isPlainPrimaryClick(event) || !shouldHandleLink(link)) {
      return;
    }

    const targetUrl = new URL(link.href, window.location.href);
    if (targetUrl.href === window.location.href) {
      return;
    }

    event.preventDefault();
    navigateTo(targetUrl.href, { pushState: true, label: 'Opening...' });
  });

  document.addEventListener('keydown', function (event) {
    const modal = getCommandModal();
    if (!modal || modal.hidden || !modal.classList.contains('is-visible')) {
      return;
    }

    if (event.key === 'Escape') {
      closeCommandModal();
      return;
    }

    if (event.key !== 'Tab') {
      return;
    }

    const focusable = getModalFocusableElements();
    if (!focusable.length) {
      event.preventDefault();
      getCommandModalSheet()?.focus?.();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
      return;
    }

    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  window.MOON_UI = {
    showToast,
    setPageLoading,
    navigateTo,
    runPageInitializers,
    openCommandModal,
    closeCommandModal,
  };
})();
