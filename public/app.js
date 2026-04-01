(function () {
  let navigationInFlight = false;

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

  function replacePageContent(nextDocument) {
    const nextLayout = nextDocument.querySelector('.layout');
    const currentLayout = document.querySelector('.layout');

    if (!nextLayout || !currentLayout) {
      throw new Error('Could not update page layout.');
    }

    document.title = nextDocument.title;
    document.body.classList.remove('page-ready');
    currentLayout.replaceWith(nextLayout);
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
      replacePageContent(nextDocument);
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

  window.MOON_UI = {
    showToast,
    setPageLoading,
    navigateTo,
    runPageInitializers,
  };
})();
