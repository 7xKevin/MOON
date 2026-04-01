(function () {
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
      return url.origin === window.location.origin;
    } catch {
      return false;
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    requestAnimationFrame(function () {
      document.body.classList.add('page-ready');
    });
  });

  window.addEventListener('pageshow', function () {
    document.body.classList.add('page-ready');
    document.body.classList.remove('page-leaving');
    setPageLoading(false);
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
    document.body.classList.add('page-leaving');
    setPageLoading(true, 'Opening...');
    window.setTimeout(function () {
      window.location.href = targetUrl.href;
    }, 150);
  });

  window.MOON_UI = {
    showToast,
    setPageLoading,
  };
})();
