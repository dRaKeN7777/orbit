/**
 * Login screen.
 *
 * Rendered instead of the app shell when the backend reports that a session is
 * required and none is present. It deliberately depends on nothing but the API
 * client and plain DOM, so it still renders if a view module or the activity
 * console is broken.
 *
 * The session cookie is HttpOnly, so there is nothing for the client to store:
 * on success we simply re-enter the app shell and let the browser carry the
 * cookie from then on.
 */

import { endpoints, ApiError } from './api.js';

const LOGO = `
<svg class="login-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
  <ellipse cx="12" cy="12" rx="10" ry="4.6" transform="rotate(-28 12 12)"></ellipse>
  <circle cx="12" cy="12" r="3.1" fill="currentColor" stroke="none"></circle>
  <circle cx="20.1" cy="8.7" r="1.5" fill="currentColor" stroke="none"></circle>
</svg>`;

export function renderLogin({ onAuthenticated } = {}) {
  const app = document.querySelector('.app');
  if (app) app.hidden = true;

  const screen = document.createElement('div');
  screen.className = 'login-screen';
  screen.innerHTML = `
    <form class="login-card" id="login-form" novalidate>
      <div class="login-brand">
        ${LOGO}
        <span class="login-wordmark">Orbit</span>
      </div>

      <h1 class="login-title">Sign in</h1>
      <p class="login-sub">This instance is password protected.</p>

      <label class="login-field">
        <span class="login-label">Username</span>
        <input id="login-user" name="username" type="text" autocomplete="username"
               spellcheck="false" autocapitalize="none" required />
      </label>

      <label class="login-field">
        <span class="login-label">Password</span>
        <input id="login-pass" name="password" type="password"
               autocomplete="current-password" required />
      </label>

      <p class="login-error" id="login-error" role="alert" hidden></p>

      <button class="btn btn-primary login-submit" id="login-submit" type="submit">
        Sign in
      </button>
    </form>
  `;
  document.body.appendChild(screen);

  const form = screen.querySelector('#login-form');
  const userInput = screen.querySelector('#login-user');
  const passInput = screen.querySelector('#login-pass');
  const submit = screen.querySelector('#login-submit');
  const errorEl = screen.querySelector('#login-error');

  const showError = (message) => {
    errorEl.textContent = message;
    errorEl.hidden = false;
  };
  const clearError = () => {
    errorEl.textContent = '';
    errorEl.hidden = true;
  };

  let busy = false;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;

    const username = userInput.value.trim();
    const password = passInput.value;

    if (!username || !password) {
      showError('Enter both a username and a password.');
      (username ? passInput : userInput).focus();
      return;
    }

    clearError();
    busy = true;
    submit.disabled = true;
    submit.textContent = 'Signing in…';

    try {
      await endpoints.login(username, password);
      screen.remove();
      if (app) app.hidden = false;
      if (typeof onAuthenticated === 'function') onAuthenticated();
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : 'Could not sign in. Check that the backend is running.';
      showError(message);
      passInput.value = '';
      passInput.focus();
    } finally {
      busy = false;
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  });

  // Autofocus after paint so the caret lands in the field reliably.
  requestAnimationFrame(() => userInput.focus());
  return screen;
}

export default { renderLogin };
