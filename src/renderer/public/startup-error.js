/*
 * Startup failure screen.
 *
 * Loaded as a plain (non-module) script before the app bundle, so it's
 * already listening if the bundle fails before React can render anything -
 * e.g. a dependency throwing while it loads (like mismatched react /
 * react-dom versions), or a script that fails to load at all. Without this,
 * those failures leave a blank window with the error only in DevTools.
 *
 * It only takes over while #root is still empty: once the app has rendered,
 * errors are the app's to handle (see AppErrorBoundary), and a stray error
 * must never replace a working window. It lives in public/ (served as-is)
 * because the Content-Security-Policy forbids inline scripts.
 */
(function () {
  'use strict';

  var shown = false;

  function appHasRendered() {
    var root = document.getElementById('root');
    return !!root && root.childElementCount > 0;
  }

  function describe(error) {
    if (error && typeof error === 'object') {
      var message = error.message ? String(error.message) : String(error);
      return { message: message, stack: error.stack ? String(error.stack) : '' };
    }
    return { message: String(error), stack: '' };
  }

  function hintFor(message) {
    if (/Incompatible React versions/i.test(message)) {
      return (
        'The app was built with mismatched versions of its React packages. If you are running ' +
        'Phosphor Notes from source, run "npm install" and start it again; otherwise, reinstall ' +
        'the app.'
      );
    }
    if (/Failed to fetch dynamically imported module|failed to load/i.test(message)) {
      return 'Part of the app could not be loaded. Try restarting it, or reinstalling if that does not help.';
    }
    return 'Try restarting the app. If this keeps happening, please report it with the details below.';
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  var STYLE =
    '.startup-error{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
    'max-width:640px;margin:12vh auto;padding:0 24px;color:#1d1d1f;line-height:1.5}' +
    '.startup-error h1{font-size:20px;margin:0 0 12px}' +
    '.startup-error p{margin:0 0 12px}' +
    '.startup-error pre{white-space:pre-wrap;word-break:break-word;font-size:12px;' +
    'background:#f2f2f4;border-radius:8px;padding:12px;max-height:40vh;overflow:auto}' +
    '.startup-error summary{cursor:pointer;margin:8px 0}' +
    '.startup-error .actions{display:flex;gap:8px;margin-top:16px}' +
    '.startup-error button{font:inherit;font-size:13px;padding:6px 14px;border-radius:6px;' +
    'border:1px solid #c7c7cc;background:#fff;color:inherit;cursor:pointer}' +
    '.startup-error button.primary{background:#007aff;border-color:#007aff;color:#fff}' +
    '@media (prefers-color-scheme:dark){body{background:#1e1e1e}' +
    '.startup-error{color:#e5e5e7}.startup-error pre{background:#2c2c2e}' +
    '.startup-error button{background:#2c2c2e;border-color:#48484a}}';

  function show(error) {
    if (shown || appHasRendered()) return;
    shown = true;

    var info = describe(error);
    var details =
      info.stack && info.stack.indexOf(info.message) !== -1
        ? info.stack
        : info.message + (info.stack ? '\n\n' + info.stack : '');

    var style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    var box = el('div', 'startup-error');
    box.setAttribute('role', 'alert');
    box.appendChild(el('h1', '', "Phosphor Notes couldn't start"));
    box.appendChild(
      el('p', '', 'Something went wrong while loading the app. Your notes have not been changed.')
    );
    box.appendChild(el('p', '', hintFor(info.message)));
    box.appendChild(el('pre', '', info.message));

    if (info.stack) {
      var more = el('details');
      more.appendChild(el('summary', '', 'Technical details'));
      more.appendChild(el('pre', '', details));
      box.appendChild(more);
    }

    var actions = el('div', 'actions');
    var reload = el('button', 'primary', 'Reload');
    reload.type = 'button';
    reload.addEventListener('click', function () {
      window.location.reload();
    });
    var copy = el('button', '', 'Copy details');
    copy.type = 'button';
    copy.addEventListener('click', function () {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(details).then(function () {
          copy.textContent = 'Copied';
        });
      }
    });
    actions.appendChild(reload);
    actions.appendChild(copy);
    box.appendChild(actions);

    document.body.appendChild(box);

    // If the app does manage to render after all (the error wasn't fatal after
    // all, e.g. an early stray promise rejection), get out of its way.
    var root = document.getElementById('root');
    if (root && typeof MutationObserver === 'function') {
      var observer = new MutationObserver(function () {
        if (appHasRendered()) {
          observer.disconnect();
          box.remove();
          style.remove();
        }
      });
      observer.observe(root, { childList: true });
    }
  }

  window.addEventListener(
    'error',
    function (event) {
      // A <script> that failed to load fires a non-bubbling error on the element
      // itself, seen here only because this listener runs in the capture phase.
      var target = event.target;
      if (target && typeof target.tagName === 'string') {
        // An element's load error. Only a failed <script> is fatal; images etc. are not.
        if (target.tagName === 'SCRIPT') {
          show(new Error('A required script failed to load: ' + (target.src || 'inline script')));
        }
        return;
      }
      show(event.error || event.message);
    },
    true
  );

  window.addEventListener('unhandledrejection', function (event) {
    show(event.reason);
  });
})();
