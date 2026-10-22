document.addEventListener('DOMContentLoaded', () => {
  wireAuthToggleTransition();
  initTheme();
  guardRoute();
  renderSidebar();
  wireMarkAllRead();
  updateNotifBadge();
  setInterval(updateNotifBadge, 60000);
  wireThemeToggle();
  wireLogout();
  wireSignupForm();
  wireLoginForm();
  renderMentorList();
  renderRequests();
  setRequestsSubtitle();
  wireProfileForm();
  renderEvents();
  renderOpportunities();
  wireRoleVisibility();
  renderAdminTable();
  renderNotifications();
  updateSidebar();
  wireAdminTabs();
  renderAdminEvents();
  wireAdminEventForm();
  renderAdminOpportunities();
  renderAdminLogs();
  wireAdminSearch();
  wireSidebarToggle();
  wireEventsPage();
  renderAdminPendingEvents();
  wireOpportunitiesPage();
  renderMentorDashboard();
  renderMenteeDashboard();
  renderAdminOverview();
  wireForgotPasswordForm();
  wireResetPasswordForm();
  renderAccountSettings();
  renderAdminVerification();
  wireHrImport();
  checkAdminTwoFactor();
  wireOnboarding();
});

// Same server as the page when served over http(s); localhost when a page is opened as a file
const API_BASE = location.protocol === 'file:' ? 'http://localhost:4000/api' : `${location.origin}/api`;

/*
 * Every API call goes through here. The session lives in an HttpOnly cookie
 * that page scripts cannot read, so nothing secret is kept in localStorage.
 * The custom header is what the server's CSRF check looks for. If the
 * session has ended (expired, logged out elsewhere, suspended), the person
 * is sent to the login page instead of seeing broken pages.
 */
const AUTH_PATHS = ['/auth/login', '/auth/google', '/auth/2fa/verify', '/auth/signup', '/auth/forgot-password', '/auth/reset-password', '/auth/logout'];
(function secureApiCalls() {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith(API_BASE)) return nativeFetch(input, init);
    const headers = new Headers(init.headers || {});
    headers.delete('Authorization');
    headers.set('X-Requested-With', 'AlumNet');
    const res = await nativeFetch(input, { ...init, headers, credentials: 'include' });
    const path = url.slice(API_BASE.length);
    if (res.status === 401 && !AUTH_PATHS.some((p) => path.startsWith(p))) {
      clearSession();
      const page = location.pathname.split('/').pop();
      if (PAGE_ROLES[page] || page === 'onboarding.html') window.location.href = 'login.html?expired=1';
    }
    return res;
  };
})();

function clearSession() {
  localStorage.removeItem('alumnet_token');
  localStorage.removeItem('alumnet_role');
}

const HOME_PAGE = { mentee: 'mentee-dashboard.html', mentor: 'mentor-dashboard.html', admin: 'admin.html' };

const PAGE_ROLES = {
  'mentee-dashboard.html': ['mentee'],
  'mentor-dashboard.html': ['mentor'],
  'recommendations.html': ['mentee'],
  'requests.html': ['mentee', 'mentor'],
  'profile.html': ['mentee', 'mentor'],
  'events.html': ['mentee', 'mentor'],
  'opportunities.html': ['mentee', 'mentor'],
  'notifications.html': ['mentee', 'mentor'],
  'settings.html': ['mentee', 'mentor', 'admin'],
  'onboarding.html': ['mentee', 'mentor'],
  'admin.html': ['admin']
};

const NAV_CONFIG = {
  mentee: [
    {
      group: 'Network', links: [
        { href: 'mentee-dashboard.html', label: 'Dashboard' },
        { href: 'recommendations.html', label: 'Find a mentor' },
        { href: 'requests.html', label: 'My requests' },
        { href: 'profile.html', label: 'My profile' },
        { href: 'settings.html', label: 'Account settings' }
      ]
    },
    {
      group: 'Community', links: [
        { href: 'events.html', label: 'Alumni events' },
        { href: 'opportunities.html', label: 'Career opportunities' },
        { href: 'notifications.html', label: 'Notifications' }
      ]
    }
  ],
  mentor: [
    {
      group: 'Mentorship', links: [
        { href: 'mentor-dashboard.html', label: 'Dashboard' },
        { href: 'requests.html', label: 'Mentee requests' },
        { href: 'profile.html', label: 'My profile' },
        { href: 'settings.html', label: 'Account settings' }
      ]
    },
    {
      group: 'Community', links: [
        { href: 'events.html', label: 'Alumni events' },
        { href: 'opportunities.html', label: 'Career opportunities' },
        { href: 'notifications.html', label: 'Notifications' }
      ]
    }
  ],
  admin: [
    {
      group: 'Platform', links: [
        { tab: 'overview', label: 'Overview' },
        { tab: 'verification', label: 'Verification' },
        { tab: 'users', label: 'User management' },
        { tab: 'hr', label: 'HR records' },
        { tab: 'events', label: 'Event management' },
        { tab: 'opportunities', label: 'Content moderation' },
        { tab: 'logs', label: 'Activity log' }
      ]
    },
    {
      group: 'Account', links: [
        { href: 'settings.html', label: 'Account settings' }
      ]
    }
  ]
};

function renderFlightMap() {
  const mount = document.getElementById('flight-path-mount');
  if (!mount) return;

  mount.innerHTML = `
    <svg class="flight-path-svg" viewBox="0 0 500 800" preserveAspectRatio="none">
      <path id="flight-path" class="path" d="M 50,620 C 140,420 260,380 180,220 C 120,110 280,70 420,40" />
      <g>
        <path d="M 0,-6 L 10,0 L 0,6 L 3,0 Z" fill="#ffffff" opacity="0.85">
          <animateMotion dur="10s" repeatCount="indefinite" rotate="auto">
            <mpath href="#flight-path" />
          </animateMotion>
        </path>
      </g>
      <circle cx="50" cy="620" r="3" fill="var(--kq-red)" />
      <circle cx="420" cy="40" r="3" fill="var(--kq-red)" />
    </svg>`;
}

function navigateWithFade(href) {
  const panel = document.querySelector('.auth-form-inner');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const motion = document.querySelector('#flight-path-mount animateMotion');
  if (motion && !reduced) {
    motion.setAttribute('dur', '0.4s');
    motion.beginElement();
  }

  if (!panel || reduced) { window.location.href = href; return; }
  panel.classList.add('leaving');
  setTimeout(() => { window.location.href = href; }, 320);
}

function wireAuthToggleTransition() {
  document.querySelectorAll('.auth-toggle a:not(.active)').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigateWithFade(link.getAttribute('href'));
    });
  });
}

function guardRoute() {
  const page = location.pathname.split('/').pop();
  const allowed = PAGE_ROLES[page];
  if (!allowed) return;
  const token = localStorage.getItem('alumnet_token');
  const role = localStorage.getItem('alumnet_role');
  if (!token) { window.location.href = 'login.html'; return; }
  if (!allowed.includes(role)) window.location.href = HOME_PAGE[role] || 'login.html';
}

function renderSidebar() {
  const nav = document.getElementById('sidebar-nav');
  if (!nav) return;
  const role = localStorage.getItem('alumnet_role');
  const groups = NAV_CONFIG[role] || [];
  const currentPage = location.pathname.split('/').pop();

  if (role === 'admin') {
    const onAdminPage = currentPage === 'admin.html';
    nav.innerHTML = groups.map((g) => `
      <div class="nav-group">
        <div class="nav-group-label">${g.group}</div>
        ${g.links.map((l) => {
          if (l.href) return `<a class="nav-link ${l.href === currentPage ? 'active' : ''}" href="${l.href}">${l.label}</a>`;
          // Tabs switch in place on the admin page; from other pages they open admin.html at that tab
          return onAdminPage
            ? `<a class="nav-link" href="#${l.tab}" data-admin-tab="${l.tab}">${l.label}</a>`
            : `<a class="nav-link" href="admin.html#${l.tab}">${l.label}</a>`;
        }).join('')}
      </div>`).join('');
    return;
  }

  nav.innerHTML = groups.map((g) => `
    <div class="nav-group">
      <div class="nav-group-label">${g.group}</div>
      ${g.links.map((l) => `<a class="nav-link ${l.href === currentPage ? 'active' : ''}" href="${l.href}">${l.label}</a>`).join('')}
    </div>`).join('');
}

function initTheme() {
  const saved = localStorage.getItem('alumnet_theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  const checkbox = document.getElementById('theme-toggle-checkbox');
  if (checkbox) checkbox.checked = saved === 'dark';
}

function wireThemeToggle() {
  const checkbox = document.getElementById('theme-toggle-checkbox');
  if (!checkbox) return;
  checkbox.addEventListener('change', () => {
    const next = checkbox.checked ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('alumnet_theme', next);
  });
}

function wireLogout() {
  const btn = document.getElementById('logout-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    try { await fetch(`${API_BASE}/auth/logout`, { method: 'POST' }); } catch { /* offline: still clear locally */ }
    clearSession();
    window.location.href = 'login.html';
  });
}

function setRequestsSubtitle() {
  const el = document.getElementById('requests-subtitle');
  if (!el) return;
  const role = localStorage.getItem('alumnet_role');
  el.textContent = role === 'mentor'
    ? 'Requests from mentees awaiting your decision.'
    : 'Mentorship requests you have sent to mentors.';
}

function wireRoleVisibility() {
  const role = localStorage.getItem('alumnet_role');
  const postBtn = document.getElementById('post-opportunity-btn');
  if (postBtn) postBtn.style.display = role === 'mentor' ? 'inline-flex' : 'none';
}

async function updateSidebar() {
  const el = document.querySelector('.app-sidebar-foot');
  const token = localStorage.getItem('alumnet_token');
  if (!el || !token) return;
  try {
    const res = await fetch(`${API_BASE}/profile/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const data = await res.json();
    el.innerHTML = `${data.name}<br>${data.department || ''}`;
  } catch { }
}

/* --------------------------------------------------------------------
   Signup / Login
   -------------------------------------------------------------------- */

function wireSignupForm() {
  const startForm = document.getElementById('signup-start-form');
  if (!startForm) return;

  const steps = ['su-start', 'su-sent', 'su-checking', 'su-password', 'su-details', 'su-submitted', 'su-invalid'];
  const show = (id) => steps.forEach((s) => {
    const el = document.getElementById(s);
    if (el) el.style.display = s === id ? 'block' : 'none';
  });

  function signedIn(result) {
    saveSession(result);
    navigateWithFade(result.onboardingRequired ? 'onboarding.html' : (HOME_PAGE[result.role] || 'login.html'));
  }

  // Step 1: staff number and email. The reply is the same whatever was
  // entered, so nobody can use this form to find out who works at KQ.
  startForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('su-start-error');
    showFormError(errorEl, '');
    const staffNumber = startForm.staffNumber.value.trim().toUpperCase();
    const email = startForm.email.value.trim().toLowerCase();
    if (!/^KQ\d{4,6}$/.test(staffNumber)) { showFormError(errorEl, 'Enter your staff number, for example KQ48213.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showFormError(errorEl, 'Enter a valid email address.'); return; }
    if (!startForm.acceptPrivacy.checked) { showFormError(errorEl, 'Please read and accept the privacy notice to continue.'); return; }

    const btn = startForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Sending...';
    try {
      const { ok, data } = await postJSON('/auth/signup/start', { staffNumber, email, acceptPrivacy: true });
      if (!ok) { showFormError(errorEl, data.error || 'Something went wrong. Try again.'); return; }
      document.getElementById('su-sent-email').textContent = email;
      show('su-sent');
    } catch {
      showFormError(errorEl, 'Could not reach the server.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Continue';
    }
  });
  document.getElementById('su-again').addEventListener('click', () => { startForm.reset(); show('su-start'); });

  // Step 2: the emailed link brings the person back here with a token
  const token = new URLSearchParams(location.search).get('token');
  if (!token) return;
  // Keep the token out of the address bar, history and screenshots
  history.replaceState(null, '', 'signup.html');
  show('su-checking');

  (async () => {
    let data;
    try {
      const res = await fetch(`${API_BASE}/auth/signup/link?token=${encodeURIComponent(token)}`);
      data = await res.json();
      if (!res.ok) {
        document.getElementById('su-invalid-text').textContent = data.error || 'It may have expired or already been used.';
        show('su-invalid');
        return;
      }
    } catch {
      document.getElementById('su-invalid-text').textContent = 'Could not reach the server. Open the link again in a moment.';
      show('su-invalid');
      return;
    }

    if (data.state === 'set_password') {
      const roleText = data.role === 'mentor'
        ? 'HR records show you as former Kenya Airways staff, so you will join as a mentor.'
        : 'HR records show you as current Kenya Airways staff, so you will join as a mentee.';
      document.getElementById('su-welcome').textContent = `Welcome, ${data.name.split(' ')[0]}`;
      document.getElementById('su-role-line').textContent = `${roleText} ${data.department ? 'Department: ' + data.department + '.' : ''} Choose how you will sign in.`;
      show('su-password');
      wirePasswordToggle('su-toggle', 'su-pass');

      const form = document.getElementById('signup-password-form');
      const errorEl = document.getElementById('su-password-error');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        showFormError(errorEl, '');
        const problem = passwordProblem(form.password.value);
        if (problem) { showFormError(errorEl, problem); return; }
        if (form.password.value !== form.confirm.value) { showFormError(errorEl, 'Passwords do not match.'); return; }
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
          const r = await postJSON('/auth/signup/complete', { token, password: form.password.value });
          if (!r.ok) { showFormError(errorEl, r.data.error || 'Could not create your account.'); return; }
          signedIn(r.data);
        } catch {
          showFormError(errorEl, 'Could not reach the server.');
        } finally {
          btn.disabled = false;
        }
      });

      const googleWrap = document.getElementById('su-google');
      renderGoogleButton(document.getElementById('su-google-btn'), async (credential) => {
        showFormError(errorEl, '');
        try {
          const r = await postJSON('/auth/signup/complete', { token, googleCredential: credential });
          if (!r.ok) { showFormError(errorEl, r.data.error || 'Google sign-up failed.'); return; }
          signedIn(r.data);
        } catch {
          showFormError(errorEl, 'Could not reach the server.');
        }
      }, 'signup_with').then((shown) => { googleWrap.style.display = shown ? 'block' : 'none'; });
      return;
    }

    // Email confirmed but it is not the one HR holds: collect details for review
    show('su-details');
    const form = document.getElementById('signup-details-form');
    const errorEl = document.getElementById('su-details-error');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showFormError(errorEl, '');
      const fullName = form.fullName.value.trim();
      const phone = form.phone.value.trim();
      if (fullName.split(/\s+/).length < 2) { showFormError(errorEl, 'Enter your full name as HR knows it.'); return; }
      if (phone.replace(/\D/g, '').length < 9) { showFormError(errorEl, 'Enter a phone number we can reach you on.'); return; }
      const problem = passwordProblem(form.password.value);
      if (problem) { showFormError(errorEl, problem); return; }
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const r = await postJSON('/auth/signup/review', { token, fullName, phone, password: form.password.value });
        if (!r.ok) { showFormError(errorEl, r.data.error || 'Could not send your details.'); return; }
        if (r.data.message) document.getElementById('su-submitted-text').textContent = r.data.message;
        show('su-submitted');
      } catch {
        showFormError(errorEl, 'Could not reach the server.');
      } finally {
        btn.disabled = false;
      }
    });
  })();
}

/* --------------------------------------------------------------------
   Sign-in helpers shared by login, Google and two-factor
   -------------------------------------------------------------------- */

// The real session is the HttpOnly cookie. These two values only help the
// page decide which menu to draw; the server checks every request itself.
function saveSession(result) {
  localStorage.setItem('alumnet_token', 'cookie');
  localStorage.setItem('alumnet_role', result.role);
}

function showFormError(el, message) {
  if (!el) return;
  el.textContent = message;
  el.style.display = message ? 'block' : 'none';
}

async function postJSON(path, body, token) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {})
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, data };
}

// Loads Google's sign-in script once and returns the configured client ID,
// or null when Google sign-in is not available on this page
let googleReady = null;
function loadGoogleSignIn() {
  if (googleReady) return googleReady;
  googleReady = (async () => {
    if (location.protocol === 'file:') return null;
    let clientId = null;
    try {
      const res = await fetch(`${API_BASE}/config`);
      clientId = (await res.json()).googleClientId;
    } catch { return null; }
    if (!clientId) return null;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
    return clientId;
  })().catch(() => null);
  return googleReady;
}

async function renderGoogleButton(container, onCredential, text = 'signin_with') {
  if (!container) return false;
  const clientId = await loadGoogleSignIn();
  if (!clientId || !window.google) return false;
  google.accounts.id.initialize({ client_id: clientId, callback: (resp) => onCredential(resp.credential) });
  google.accounts.id.renderButton(container, {
    theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'filled_black' : 'outline',
    size: 'large',
    text,
    shape: 'rectangular',
    width: Math.min(container.offsetWidth || 360, 400)
  });
  return true;
}

/* --------------------------------------------------------------------
   Login: email, Google, then two-factor if switched on
   -------------------------------------------------------------------- */

function wireLoginForm() {
  const form = document.getElementById('login-form');
  if (!form) return;
  const toggleBtn = document.getElementById('toggle-password-login');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const pwd = document.getElementById('password');
      const show = pwd.type === 'password';
      pwd.type = show ? 'text' : 'password';
      toggleBtn.textContent = show ? 'Hide' : 'Show';
    });
  }
  const errorEl = document.getElementById('login-error');
  const loginStep = document.getElementById('login-step');
  const twoFaStep = document.getElementById('twofa-step');
  const twoFaForm = document.getElementById('twofa-form');
  const twoFaError = document.getElementById('twofa-error');
  let tempToken = null;

  // A message from the reset page, for example
  const params = new URLSearchParams(location.search);
  const notice = document.getElementById('login-notice');
  const notices = {
    reset: 'Your password has been reset. Log in with your new password.',
    expired: 'Your session has ended. Please log in again.'
  };
  const which = Object.keys(notices).find((k) => params.get(k) === '1');
  if (notice && which) {
    notice.textContent = notices[which];
    notice.style.display = 'block';
    history.replaceState(null, '', 'login.html');
  }
  if (which === 'expired') clearSession();

  // Two-factor step: app code by default, backup code if the phone is lost
  let usingBackup = false;
  const codeInput = document.getElementById('twofa-code');
  const useBackupBtn = document.getElementById('twofa-use-backup');
  function setCodeMode(backup) {
    usingBackup = backup;
    codeInput.value = '';
    codeInput.maxLength = backup ? 11 : 6;
    codeInput.placeholder = backup ? 'xxxxx-xxxxx' : '000000';
    codeInput.inputMode = backup ? 'text' : 'numeric';
    document.getElementById('twofa-label').textContent = backup ? 'Backup code' : 'Verification code';
    if (useBackupBtn) useBackupBtn.textContent = backup ? 'Use the code from my app instead' : 'Lost your phone? Use a backup code';
    codeInput.focus();
  }
  if (useBackupBtn) useBackupBtn.addEventListener('click', () => setCodeMode(!usingBackup));

  function handleResult(result) {
    if (result.twoFactorRequired) {
      tempToken = result.tempToken;
      loginStep.style.display = 'none';
      twoFaStep.style.display = 'block';
      document.getElementById('twofa-code').focus();
      return;
    }
    saveSession(result);
    navigateWithFade(result.onboardingRequired ? 'onboarding.html' : (HOME_PAGE[result.role] || 'login.html'));
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showFormError(errorEl, '');
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!email || !password) { showFormError(errorEl, 'Enter your email and password.'); return; }

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing you in...';
    try {
      const { ok, data } = await postJSON('/auth/login', { email, password });
      if (!ok) { showFormError(errorEl, data.error || 'Login failed'); return; }
      handleResult(data);
    } catch {
      showFormError(errorEl, 'Could not reach the server. Is the backend running?');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Log in';
    }
  });

  if (twoFaForm) {
    twoFaForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      showFormError(twoFaError, '');
      const code = codeInput.value.replace(/\s/g, '');
      if (!usingBackup && !/^\d{6}$/.test(code)) { showFormError(twoFaError, 'Enter the 6-digit code from your authenticator app.'); return; }
      if (usingBackup && !/^[a-z0-9]{5}-?[a-z0-9]{5}$/i.test(code)) { showFormError(twoFaError, 'Enter one of your backup codes, for example abcde-12345.'); return; }
      const btn = twoFaForm.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const { ok, data } = await postJSON('/auth/2fa/verify', { tempToken, code });
        if (!ok) {
          showFormError(twoFaError, data.error || 'Verification failed');
          if (data.error && data.error.includes('expired')) setTimeout(() => location.reload(), 1500);
          return;
        }
        handleResult(data);
      } catch {
        showFormError(twoFaError, 'Could not reach the server.');
      } finally {
        btn.disabled = false;
      }
    });
    document.getElementById('twofa-back').addEventListener('click', () => {
      tempToken = null;
      setCodeMode(false);
      twoFaStep.style.display = 'none';
      loginStep.style.display = 'block';
    });
  }

  const googleWrap = document.getElementById('google-signin');
  renderGoogleButton(document.getElementById('google-btn'), async (credential) => {
    showFormError(errorEl, '');
    try {
      const { ok, data } = await postJSON('/auth/google', { credential });
      if (!ok) { showFormError(errorEl, data.error || 'Google sign-in failed'); return; }
      handleResult(data);
    } catch {
      showFormError(errorEl, 'Could not reach the server.');
    }
  }).then((shown) => { if (googleWrap) googleWrap.style.display = shown ? 'block' : 'none'; });
}

/* --------------------------------------------------------------------
   Forgot and reset password
   -------------------------------------------------------------------- */

const PASSWORD_RULE = 'At least 8 characters, with letters and numbers.';
function passwordProblem(pw) {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must include both letters and numbers.';
  return null;
}

function wireForgotPasswordForm() {
  const form = document.getElementById('forgot-form');
  if (!form) return;
  const errorEl = document.getElementById('forgot-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showFormError(errorEl, '');
    const email = form.email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showFormError(errorEl, 'Enter the email on your account.'); return; }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Sending...';
    try {
      const { ok, data } = await postJSON('/auth/forgot-password', { email });
      if (!ok) { showFormError(errorEl, data.error || 'Something went wrong.'); return; }
      document.getElementById('forgot-step').style.display = 'none';
      document.getElementById('forgot-done').style.display = 'block';
    } catch {
      showFormError(errorEl, 'Could not reach the server.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send reset link';
    }
  });
}

function wireResetPasswordForm() {
  const form = document.getElementById('reset-form');
  if (!form) return;
  const errorEl = document.getElementById('reset-error');
  const token = new URLSearchParams(location.search).get('token');
  if (token) history.replaceState(null, '', 'reset-password.html');
  if (!token) {
    document.getElementById('reset-step').style.display = 'none';
    document.getElementById('reset-invalid').style.display = 'block';
    return;
  }
  wirePasswordToggle('toggle-reset-password', 'reset-password');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showFormError(errorEl, '');
    const password = form.password.value;
    const problem = passwordProblem(password);
    if (problem) { showFormError(errorEl, problem); return; }
    if (password !== form.confirm.value) { showFormError(errorEl, 'Passwords do not match.'); return; }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const { ok, data } = await postJSON('/auth/reset-password', { token, password });
      if (!ok) { showFormError(errorEl, data.error || 'Could not reset your password.'); return; }
      window.location.href = 'login.html?reset=1';
    } catch {
      showFormError(errorEl, 'Could not reach the server.');
    } finally {
      btn.disabled = false;
    }
  });
}

function wirePasswordToggle(buttonId, inputId) {
  const btn = document.getElementById(buttonId);
  const input = document.getElementById(inputId);
  if (!btn || !input) return;
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
  });
}

/* --------------------------------------------------------------------
   Mentor recommendations (FR-04): calls the ML service
   -------------------------------------------------------------------- */

async function renderMentorList() {
  const list = document.getElementById('mentor-list');
  if (!list) return;
  const token = localStorage.getItem('alumnet_token');
  if (!token) { window.location.href = 'login.html'; return; }

  list.innerHTML = '<p style="color:var(--slate); padding:20px 4px;">Loading recommendations...</p>';

  try {
    const [recRes, reqRes] = await Promise.all([
      fetch(`${API_BASE}/recommendations`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${API_BASE}/mentorship-requests`, { headers: { Authorization: `Bearer ${token}` } })
    ]);
    const data = await recRes.json();
    const myRequests = reqRes.ok ? await reqRes.json() : [];
    const pendingMentorIds = new Set(
      myRequests.filter((r) => r.status === 'pending').map((r) => r.other_user_id)
    );

    if (!recRes.ok) {
      list.innerHTML = data.code === 'profile_incomplete'
        ? `<div class="md">${mdEmpty('search', 'Finish your profile to see matches', 'Mentors are matched on your skills, experience and career interests. Add them and your matches appear here.', 'profile.html#edit', 'Complete my profile')}</div>`
        : `<p style="color:var(--kq-red); padding:20px 4px;">${escapeHTML(data.error || 'Could not load recommendations.')}</p>`;
      return;
    }
    if (!data.length) {
      list.innerHTML = '<p style="color:var(--slate); padding:20px 4px;">No mentor matches yet.</p>';
      return;
    }
    list.innerHTML = data.map((m) => apiMentorCardHTML(m, pendingMentorIds.has(m.mentor_id))).join('');
    wireMentorCardActions(list);
  } catch {
    list.innerHTML = '<p style="color:var(--kq-red); padding:20px 4px;">Could not reach the server.</p>';
  }
}
// Three small bars explaining where a match comes from
function matchBreakdownHTML(b) {
  if (!b) return '';
  const rows = [['Skills', b.skills], ['Experience', b.experience], ['Your goals', b.goals]];
  return `
    <div class="match-breakdown">
      ${rows.map(([label, v]) => `
        <div class="mb-row" title="${v === null ? 'Not enough information on one of the profiles' : label + ' similarity'}">
          <span class="mb-label">${label}</span>
          <span class="mb-track"><span class="mb-fill" style="width:${v ?? 0}%"></span></span>
          <span class="mb-value">${v === null ? 'n/a' : Math.round(v) + '%'}</span>
        </div>`).join('')}
    </div>`;
}

function apiMentorCardHTML(m, alreadyRequested) {
  const initials = m.name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return `
    <article class="mentor-card">
      <div class="mentor-avatar">${initials}</div>
      <div>
        <div class="mentor-name-row">
          <span class="mentor-name" style="cursor:pointer; text-decoration:underline;" data-action="view-profile" data-mentor-id="${m.mentor_id}">${escapeHTML(m.name)}</span>
          <span class="match-score">${m.score}% match</span>
        </div>
        <div class="mentor-meta" style="margin:0 0 8px;">
          ${escapeHTML(m.department || '')}${m.years_of_experience ? ' · ' + m.years_of_experience + ' yrs experience' : ''}
        </div>
        ${matchBreakdownHTML(m.breakdown)}
      </div>
      <div class="mentor-actions">
        <button class="btn ${alreadyRequested ? 'btn-secondary' : 'btn-primary'}" data-action="request" data-mentor-id="${m.mentor_id}" ${alreadyRequested ? 'disabled' : ''}>
          ${alreadyRequested ? 'Requested' : 'Request'}
        </button>
      </div>
    </article>`;
}

function wireMentorCardActions(list) {
  const token = localStorage.getItem('alumnet_token');

  list.querySelectorAll('[data-action="bookmark"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('saved');
      // TODO: POST/DELETE /api/bookmarks/:mentorId
    });
  });

  list.querySelectorAll('[data-action="request"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await fetch(`${API_BASE}/mentorship-requests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ mentorId: btn.dataset.mentorId })
        });
        const result = await res.json();
        if (!res.ok) { alert(result.error || 'Could not send request'); btn.disabled = false; return; }
        btn.textContent = 'Requested';
      } catch {
        alert('Could not reach the server.');
        btn.disabled = false;
      }
    });
  });
  list.querySelectorAll('[data-action="view-profile"]').forEach((el) => {
    el.addEventListener('click', () => openMentorProfile(el.dataset.mentorId));
  });
}

/* --------------------------------------------------------------------
   Mentorship requests (FR-05, FR-06)
   -------------------------------------------------------------------- */

let allMyRequests = [];

async function renderRequests() {
  const list = document.getElementById('requests-list');
  if (!list) return;
  const token = localStorage.getItem('alumnet_token');
  if (!token) return;

  let activeTab = 'pending';
  const tabs = document.querySelectorAll('.tab');

  async function load() {
    list.innerHTML = '<p style="color:var(--slate); padding:20px 4px;">Loading...</p>';
    try {
      const res = await fetch(`${API_BASE}/mentorship-requests`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) { list.innerHTML = `<p style="color:var(--kq-red); padding:20px 4px;">${data.error}</p>`; return; }
      allMyRequests = data;
      draw();
    } catch {
      list.innerHTML = '<p style="color:var(--kq-red); padding:20px 4px;">Could not reach the server.</p>';
    }
  }

  function draw() {
    const filtered = allMyRequests.filter((r) => r.status === activeTab);
    list.innerHTML = filtered.length
      ? filtered.map(requestCardHTML).join('')
      : `<p style="color: var(--slate); padding: 20px 4px;">No ${activeTab} requests.</p>`;

    list.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (btn.dataset.action === 'end' && !confirm('End this mentorship?')) return;
        btn.closest('.request-card').querySelectorAll('button').forEach((b) => (b.disabled = true));

        try {
          let res;
          if (btn.dataset.action === 'withdraw') {
            res = await fetch(`${API_BASE}/mentorship-requests/${btn.dataset.requestId}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${token}` }
            });
          } else if (btn.dataset.action === 'end') {
            res = await fetch(`${API_BASE}/mentorship-requests/${btn.dataset.requestId}/end`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}` }
            });
          } else {
            res = await fetch(`${API_BASE}/mentorship-requests/${btn.dataset.requestId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ decision: btn.dataset.action })
            });
          }

          if (!res.ok) { const err = await res.json(); alert(err.error || 'Action failed'); }
          load();
        } catch {
          alert('Could not reach the server.');
        }
      });
    });
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      activeTab = tab.dataset.tab;
      draw();
    });
  });

  load();
}

function requestCardHTML(r) {
  const role = localStorage.getItem('alumnet_role');
  const canDecide = role === 'mentor' && r.status === 'pending';
  const canWithdraw = role === 'mentee' && r.status === 'pending';
  const canEnd = r.status === 'accepted';
  const date = new Date(r.requested_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  let actionHTML;
  if (canDecide) {
    actionHTML = `<div style="display:flex; gap:8px;">
      <button class="btn btn-primary" data-action="accepted" data-request-id="${r.request_id}">Accept</button>
      <button class="btn btn-secondary" data-action="declined" data-request-id="${r.request_id}">Decline</button>
    </div>`;
  } else if (canWithdraw) {
    actionHTML = `<button class="btn btn-secondary" data-action="withdraw" data-request-id="${r.request_id}">Withdraw</button>`;
  } else if (canEnd) {
    actionHTML = `<button class="btn btn-secondary" data-action="end" data-request-id="${r.request_id}">End mentorship</button>`;
  } else {
    actionHTML = `<span class="request-status ${r.status}">${r.status === 'accepted' ? 'active' : r.status}</span>`;
  }

  return `
    <div class="request-card">
      <div>
        <strong>${escapeHTML(r.other_name)}</strong><br>
        <span style="font-size:0.82rem; color:var(--slate);">${escapeHTML(r.other_department || '')} · ${r.status === 'ended' ? 'Ended' : 'Requested'} on ${date}</span>
      </div>
      ${actionHTML}
    </div>`;
}

/* --------------------------------------------------------------------
   Profile (FR-03)
   -------------------------------------------------------------------- */

/* ===================== Professional profile ===================== */

function splitList(text) {
  return String(text || '').split(/[,;\n]+/).map((t) => t.trim()).filter(Boolean);
}

function textOrEmpty(value, emptyText) {
  return value
    ? `<p>${escapeHTML(value).replace(/\n/g, '<br>')}</p>`
    : `<p class="pf-empty">${emptyText}</p>`;
}

// One definition of profile strength, shared by the profile page and both dashboards,
// so the percentage and checklist are the same everywhere.
// Each item: [label, value, used for matching, phrase for the "next step" hint]
function profileChecklist(p) {
  const checks = [
    ['Headline', p.headline, false, 'a headline'],
    ['About', p.bio, false, 'an About section'],
    ['Skills', p.skills, true, 'your skills'],
    ['Experience', p.experience, true, 'your experience'],
    ['Career interests', p.career_interests, true, 'your career interests'],
    ['Location', p.city && p.country ? 'yes' : '', false, 'your location'],
    ['LinkedIn', p.linkedin_url, false, 'your LinkedIn profile']
  ];
  if (p.role === 'mentor') checks.push(['Years of experience', p.years_of_experience, false, 'your years of experience']);
  return checks;
}

// The fields the matching model reads; the dashboards nudge until all three are filled
function missingMatchingFields(p) {
  return ['skills', 'experience', 'career_interests'].filter((key) => !mdFilled(p[key]));
}

function profileStrengthHTML(p, { showCta = false } = {}) {
  const checks = profileChecklist(p);
  const done = checks.filter(([, v]) => mdFilled(v)).length;
  const left = checks.length - done;
  const pct = Math.round((done / checks.length) * 100);
  // Suggest a field the matching model reads first, then the rest
  const next = checks.find(([, v, matching]) => matching && !mdFilled(v)) || checks.find(([, v]) => !mdFilled(v));
  return `
    <div class="md-progress-row">
      <span class="md-progress-num">${pct}%</span>
      <span class="md-muted">${left === 0 ? 'All-star profile' : `${left} item${left === 1 ? '' : 's'} left`}</span>
    </div>
    <div class="md-progress"><div style="width:${pct}%"></div></div>
    <ul class="md-checklist">
      ${checks.map(([label, v, matching]) => `<li class="${mdFilled(v) ? 'ok' : ''}">${mdIcon(mdFilled(v) ? MD_ICONS.check : MD_ICONS.dot)}${label}${matching ? '<span class="pf-tag-match pf-tag-small">matching</span>' : ''}</li>`).join('')}
    </ul>
    ${next ? `<p class="pf-next">Next step: add ${next[3]}.</p>` : ''}
    ${showCta && next ? '<a href="profile.html#edit" class="btn btn-secondary md-btn-sm pf-strength-cta">Complete profile</a>' : ''}`;
}

// Shown when the account is linked to a Kenya Airways HR record
function verifiedBadgeHTML(label) {
  return `<span class="verified-badge" title="Checked against Kenya Airways HR records"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>${escapeHTML(label)}</span>`;
}

function drawProfile(p) {
  document.getElementById('pf-name').textContent = p.name || '';
  const avatar = document.getElementById('pf-avatar');
  avatar.textContent = mdInitials(p.name);
  avatar.style.background = colorFromName(p.name || '');

  const role = document.getElementById('pf-role');
  role.textContent = p.role === 'mentor' ? 'Mentor' : p.role === 'mentee' ? 'Mentee' : p.role;
  role.className = `role-badge ${p.role}`;
  const oldBadge = role.parentElement.querySelector('.verified-badge');
  if (oldBadge) oldBadge.remove();
  if (p.verified) role.insertAdjacentHTML('afterend', verifiedBadgeHTML(p.employment_status === 'former' ? 'Verified former KQ staff' : 'Verified current KQ staff'));

  const headline = document.getElementById('pf-headline');
  headline.textContent = p.headline || (p.role === 'mentor' ? 'Add a headline, for example "Retired Captain, 25 years with Kenya Airways"' : 'Add a headline, for example "Cabin Crew | Aspiring Safety Trainer"');
  headline.classList.toggle('pf-placeholder', !p.headline);

  const meta = [
    p.department,
    [p.city, p.country].filter(Boolean).join(', '),
    p.role === 'mentor' && p.years_of_experience ? `${p.years_of_experience} years at Kenya Airways` : ''
  ].filter(Boolean);
  document.getElementById('pf-meta').innerHTML = meta.map((m) => `<span>${escapeHTML(m)}</span>`).join('');

  const linkedin = document.getElementById('pf-linkedin');
  if (p.linkedin_url) { linkedin.href = p.linkedin_url; linkedin.style.display = 'inline-flex'; } else linkedin.style.display = 'none';

  document.getElementById('pf-bio').innerHTML = textOrEmpty(p.bio, 'Introduce yourself so others know who you are and how you can help.');
  const skills = splitList(p.skills);
  document.getElementById('pf-skills').innerHTML = skills.length
    ? skills.map((sk) => `<span class="pf-chip">${escapeHTML(sk)}</span>`).join('')
    : '<p class="pf-empty">Add your skills to get better matches.</p>';
  document.getElementById('pf-experience').innerHTML = textOrEmpty(p.experience, 'Describe your roles and responsibilities.');
  document.getElementById('pf-interests').innerHTML = textOrEmpty(p.career_interests, 'What would you like to learn or move into next?');

  document.getElementById('pf-strength').innerHTML = profileStrengthHTML(p);

  const details = [
    ['Email', p.email],
    ['Industry', p.industry],
    ['Member since', formatDate(p.created_at)]
  ].filter(([, v]) => v);
  document.getElementById('pf-details').innerHTML = details
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHTML(v)}</dd></div>`).join('');
}

async function wireProfileForm() {
  const form = document.getElementById('profile-form');
  if (!form) return;
  const token = localStorage.getItem('alumnet_token');
  if (!token) { window.location.href = 'login.html'; return; }

  const view = document.getElementById('pf-view');
  const editBtn = document.getElementById('pf-edit-btn');
  const msg = document.getElementById('profile-msg');
  let profile = {};

  async function load() {
    const res = await fetch(`${API_BASE}/profile/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('Could not load profile');
    profile = await res.json();
    drawProfile(profile);
  }

  function fillForm() {
    form.headline.value = profile.headline || '';
    document.getElementById('headline-count').textContent = form.headline.value.length;
    form.bio.value = profile.bio || '';
    form.skills.value = profile.skills || '';
    form.experience.value = profile.experience || '';
    form.interests.value = profile.career_interests || '';
    if (profile.industry) form.industry.value = profile.industry;
    form.city.value = profile.city || '';
    form.country.value = profile.country || '';
    form.linkedin.value = profile.linkedin_url || '';
    const yearsField = document.getElementById('years-field');
    yearsField.style.display = profile.role === 'mentor' ? 'block' : 'none';
    form.years.value = profile.years_of_experience ?? '';
  }

  function setEditing(on) {
    view.style.display = on ? 'none' : 'flex';
    form.style.display = on ? 'block' : 'none';
    editBtn.style.display = on ? 'none' : 'inline-flex';
    setMsg(msg, '');
    if (on) { fillForm(); form.headline.focus(); }
  }

  try { await load(); } catch (err) { console.error(err); }

  editBtn.addEventListener('click', () => setEditing(true));
  document.getElementById('pf-cancel').addEventListener('click', () => setEditing(false));
  form.headline.addEventListener('input', () => {
    document.getElementById('headline-count').textContent = form.headline.value.length;
  });
  // Open straight into edit mode from links such as profile.html#edit
  if (location.hash === '#edit') setEditing(true);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const linkedin = form.linkedin.value.trim();
    if (linkedin && !/^https:\/\/(www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/?$/.test(linkedin)) {
      setMsg(msg, 'Enter a LinkedIn profile link like https://www.linkedin.com/in/your-name');
      return;
    }
    const body = {
      headline: form.headline.value,
      bio: form.bio.value,
      skills: form.skills.value,
      experience: form.experience.value,
      careerInterests: form.interests.value,
      industry: form.industry.value,
      city: form.city.value,
      country: form.country.value,
      linkedinUrl: linkedin
    };
    if (profile.role === 'mentor') body.yearsOfExperience = form.years.value;

    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      const res = await fetch(`${API_BASE}/profile/me`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
      });
      const result = await res.json();
      if (!res.ok) { setMsg(msg, result.error || 'Could not save your profile.'); return; }
      await load();
      setEditing(false);
    } catch {
      setMsg(msg, 'Could not reach the server.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save profile';
    }
  });
}

function colorFromName(name) {
  const palette = ['#045C43', '#C8102E', '#0A7A5A', '#A00C24', '#15201C'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return palette[Math.abs(hash) % palette.length];
}


async function openMentorProfile(mentorId) {
  const token = localStorage.getItem('alumnet_token');
  const res = await fetch(`${API_BASE}/profile/${mentorId}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Could not load profile'); return; }

  const meta = [
    data.department,
    [data.city, data.country].filter(Boolean).join(', '),
    data.years_of_experience ? `${data.years_of_experience} years at Kenya Airways` : ''
  ].filter(Boolean).map(escapeHTML).join(' · ');
  const skills = splitList(data.skills);
  const section = (label, value) => value
    ? `<div class="modal-section"><div class="label">${label}</div><div class="value">${escapeHTML(value).replace(/\n/g, '<br>')}</div></div>`
    : '';

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal-card pf-modal" role="dialog" aria-modal="true" aria-label="${escapeHTML(data.name)}">
      <div class="pf-modal-head">
        <div class="pf-avatar pf-avatar-sm" style="background:${colorFromName(data.name || '')}">${mdInitials(data.name)}</div>
        <div>
          <h3>${escapeHTML(data.name)} ${data.verified ? verifiedBadgeHTML(data.verified_label || 'Verified') : ''}</h3>
          ${data.headline ? `<div class="pf-headline">${escapeHTML(data.headline)}</div>` : ''}
          <div class="modal-meta">${meta}</div>
        </div>
      </div>
      ${section('About', data.bio)}
      ${skills.length ? `<div class="modal-section"><div class="label">Skills</div><div class="pf-chips">${skills.map((sk) => `<span class="pf-chip">${escapeHTML(sk)}</span>`).join('')}</div></div>` : ''}
      ${section('Experience', data.experience)}
      ${section('Career interests', data.career_interests)}
      <div class="pf-modal-actions">
        ${data.linkedin_url ? `<a class="btn btn-secondary" href="${escapeHTML(data.linkedin_url)}" target="_blank" rel="noopener noreferrer">LinkedIn</a>` : ''}
        <button class="btn btn-primary" id="close-modal">Close</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.getElementById('close-modal').addEventListener('click', () => backdrop.remove());
}

/* --------------------------------------------------------------------
   Events (FR-07, FR-08): mentee and mentor view
   -------------------------------------------------------------------- */

let allEvents = [];
let eventFilter = 'all';

async function renderEvents() {
  const grid = document.getElementById('event-grid');
  if (!grid) return;
  const token = localStorage.getItem('alumnet_token');
  if (!token) return;

  if (!allEvents.length) {
    grid.innerHTML = '<p style="color:var(--slate); padding:20px 4px;">Loading events...</p>';
  }

  try {
    const res = await fetch(`${API_BASE}/events`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!res.ok) {
      grid.innerHTML = `<p style="color:var(--kq-red); padding:20px 4px;">${escapeHTML(data.error || 'Could not load events.')}</p>`;
      return;
    }
    allEvents = data;
    drawEvents();
  } catch {
    grid.innerHTML = '<p style="color:var(--kq-red); padding:20px 4px;">Could not reach the server.</p>';
  }
}

function drawEvents() {
  const grid = document.getElementById('event-grid');
  if (!grid) return;
  const token = localStorage.getItem('alumnet_token');
  const list = eventFilter === 'mine' ? allEvents.filter((e) => e.is_registered) : allEvents;

  if (!list.length) {
    grid.innerHTML = `<p style="color:var(--slate); padding:20px 4px;">${eventFilter === 'mine' ? "You haven't registered for any upcoming events." : 'No upcoming events yet.'
      }</p>`;
    return;
  }

  grid.innerHTML = list.map(eventCardHTML).join('');

  grid.querySelectorAll('[data-event-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const registering = btn.dataset.eventAction === 'register';
      try {
        const r = await fetch(`${API_BASE}/events/${btn.dataset.eventId}/register`, {
          method: registering ? 'POST' : 'DELETE',
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!r.ok) {
          const err = await r.json();
          alert(err.error || 'Action failed');
        }
        renderEvents();
      } catch {
        alert('Could not reach the server.');
        btn.disabled = false;
      }
    });
  });
}

function eventCardHTML(e) {
  const d = new Date(e.event_date);
  const date = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const full = e.capacity !== null && e.attendee_count >= e.capacity;
  const attendance = e.capacity !== null
    ? `${e.attendee_count} / ${e.capacity} attending`
    : `${e.attendee_count} attending`;
  const host = escapeHTML(e.is_official ? 'KQ Alumni Office' : (e.organiser_name || 'Alumni member'));

  let where;
  if (e.mode === 'virtual') {
    where = e.location
      ? `Virtual · <a href="${escapeHTML(e.location)}" target="_blank" rel="noopener noreferrer">Join link</a>`
      : 'Virtual · link shared after registering';
  } else {
    where = escapeHTML(e.location || 'Venue to be confirmed');
  }

  let button;
  if (e.is_registered) {
    button = `<button class="btn btn-secondary btn-block" data-event-action="cancel" data-event-id="${e.event_id}">Cancel registration</button>`;
  } else if (full) {
    button = '<button class="btn btn-secondary btn-block" disabled>Event full</button>';
  } else {
    button = `<button class="btn btn-primary btn-block" data-event-action="register" data-event-id="${e.event_id}">Register</button>`;
  }

  return `
    <div class="event-card">
      <div class="event-card-top">
        <span class="event-badge ${e.is_official ? 'official' : 'community'}">${e.is_official ? 'Official' : 'Community'}</span>
      </div>
      <div class="date">${date} · ${time}</div>
      <h3>${escapeHTML(e.title)}</h3>
      <p>${escapeHTML(e.description || '')}</p>
      <div class="event-meta">
        <div>${where}</div>
        <div>Hosted by ${host}</div>
        <div>${attendance}</div>
      </div>
      ${button}
    </div>`;
}

// Runs once per page load: filter tabs, and the propose button for mentors only
function wireEventsPage() {
  const tabs = document.querySelectorAll('[data-event-filter]');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      eventFilter = tab.dataset.eventFilter;
      drawEvents();
    });
  });

  const proposeBtn = document.getElementById('propose-event-btn');
  if (proposeBtn && localStorage.getItem('alumnet_role') === 'mentor') {
    proposeBtn.style.display = 'inline-flex';
    proposeBtn.addEventListener('click', openProposeEventModal);
    renderMyProposals();
  }
}

function openProposeEventModal() {
  const token = localStorage.getItem('alumnet_token');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal-card">
      <h3>Propose an event</h3>
      <div class="modal-meta">Community events are reviewed by the admin before other members can see them.</div>
      <form id="propose-event-form" novalidate>
        <div class="field"><label for="peTitle">Title</label><input type="text" id="peTitle"></div>
        <div class="field"><label for="peDate">Date and time</label><input type="datetime-local" id="peDate"></div>
        <div class="field-row">
          <div class="field">
            <label for="peMode">Format</label>
            <select id="peMode">
              <option value="in_person">In person</option>
              <option value="virtual">Virtual</option>
            </select>
          </div>
          <div class="field"><label for="peCapacity">Capacity (optional)</label><input type="number" id="peCapacity" min="1"></div>
        </div>
        <div class="field">
          <label for="peLocation" id="peLocationLabel">Venue</label>
          <input type="text" id="peLocation" placeholder="e.g. Pride Centre, Embakasi">
        </div>
        <div class="field"><label for="peDescription">Description</label><textarea id="peDescription"></textarea></div>
        <p id="pe-error" style="color:var(--kq-red); font-size:0.85rem; display:none; margin-bottom:12px;"></p>
        <div style="display:flex; gap:10px;">
          <button type="submit" class="btn btn-primary">Submit for review</button>
          <button type="button" class="btn btn-secondary" id="pe-cancel">Cancel</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('#pe-cancel').addEventListener('click', close);

  // Relabel the location field depending on the format
  const modeSel = backdrop.querySelector('#peMode');
  modeSel.addEventListener('change', () => {
    const virtual = modeSel.value === 'virtual';
    backdrop.querySelector('#peLocationLabel').textContent = virtual ? 'Meeting link' : 'Venue';
    backdrop.querySelector('#peLocation').placeholder = virtual ? 'https://...' : 'e.g. Pride Centre, Embakasi';
  });

  backdrop.querySelector('#propose-event-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = backdrop.querySelector('#pe-error');
    errorEl.style.display = 'none';

    const payload = {
      title: backdrop.querySelector('#peTitle').value,
      eventDate: backdrop.querySelector('#peDate').value,
      mode: modeSel.value,
      location: backdrop.querySelector('#peLocation').value,
      capacity: backdrop.querySelector('#peCapacity').value || null,
      description: backdrop.querySelector('#peDescription').value
    };

    try {
      const res = await fetch(`${API_BASE}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload)
      });
      const result = await res.json();
      if (!res.ok) {
        errorEl.textContent = result.error || 'Could not submit the event';
        errorEl.style.display = 'block';
        return;
      }
      close();
      renderMyProposals();
    } catch {
      errorEl.textContent = 'Could not reach the server.';
      errorEl.style.display = 'block';
    }
  });
}

async function renderMyProposals() {
  const mount = document.getElementById('my-proposals');
  if (!mount) return;
  const token = localStorage.getItem('alumnet_token');

  try {
    const res = await fetch(`${API_BASE}/events/my-proposals`, { headers: { Authorization: `Bearer ${token}` } });
    const rows = await res.json();
    if (!res.ok || !rows.length) { mount.innerHTML = ''; return; }

    mount.innerHTML = `
      <div class="section-heading"><h2>Your proposals</h2></div>
      ${rows.map((p) => `
        <div class="request-card">
          <div>
            <strong>${escapeHTML(p.title)}</strong><br>
            <span style="font-size:0.82rem; color:var(--slate);">
              ${new Date(p.event_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
            </span>
          </div>
          <span class="request-status ${p.status}">${p.status}</span>
        </div>`).join('')}`;
  } catch {
    mount.innerHTML = '';
  }
}

async function renderAdminPendingEvents() {
  const list = document.getElementById('admin-pending-events');
  if (!list) return;
  const token = localStorage.getItem('alumnet_token');

  try {
    const res = await fetch(`${API_BASE}/admin/events/pending`, { headers: { Authorization: `Bearer ${token}` } });
    const rows = await res.json();
    if (!res.ok) { list.innerHTML = `<p>${escapeHTML(rows.error || 'Could not load proposals.')}</p>`; return; }
    if (!rows.length) {
      list.innerHTML = '<p style="color:var(--slate); padding:20px 4px;">No event proposals waiting for review.</p>';
      return;
    }

    list.innerHTML = rows.map((e) => `
      <div class="opportunity-card">
        <div>
          <span class="tag">${e.mode === 'virtual' ? 'Virtual' : 'In person'}</span>
          <h3 style="font-size:1rem; margin:6px 0;">${escapeHTML(e.title)}</h3>
          <p class="mentor-blurb">${escapeHTML(e.description || '')}</p>
          <div class="mentor-meta">
            ${new Date(e.event_date).toLocaleString('en-GB')} · ${escapeHTML(e.location || '')}${e.capacity ? ' · capacity ' + e.capacity : ''}
          </div>
          <div class="mentor-meta">Proposed by ${escapeHTML(e.proposed_by_name)}</div>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-primary" data-review-event="${e.event_id}" data-decision="approved">Approve</button>
          <button class="btn btn-secondary" data-review-event="${e.event_id}" data-decision="rejected">Reject</button>
        </div>
      </div>`).join('');

    list.querySelectorAll('[data-review-event]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        await fetch(`${API_BASE}/admin/events/${btn.dataset.reviewEvent}/review`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ decision: btn.dataset.decision })
        });
        renderAdminPendingEvents();
        renderAdminEvents();
        renderAdminLogs();
      });
    });
  } catch {
    list.innerHTML = '<p style="color:var(--kq-red); padding:20px 4px;">Could not reach the server.</p>';
  }
}

/* --------------------------------------------------------------------
   Career opportunities (FR-09): mentee and mentor view
   -------------------------------------------------------------------- */

let allOpportunities = [];

const OPPORTUNITY_TYPES = {
  full_time: 'Full-time',
  part_time: 'Part-time',
  contract: 'Contract',
  consultancy: 'Consultancy',
  internal_transfer: 'Internal transfer',
  volunteer: 'Volunteer'
};

function truncate(str, n) {
  const s = String(str || '');
  return s.length > n ? s.slice(0, n).trimEnd() + '...' : s;
}

// "Closes in 3 days" when it's soon, otherwise the plain date
function closingLabel(dateStr) {
  if (!dateStr) return { text: '', soon: false };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const close = new Date(dateStr); close.setHours(0, 0, 0, 0);
  const days = Math.round((close - today) / 86400000);
  if (days === 0) return { text: 'Closes today', soon: true };
  if (days === 1) return { text: 'Closes tomorrow', soon: true };
  if (days <= 7) return { text: `Closes in ${days} days`, soon: true };
  return {
    text: `Closes ${close.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`,
    soon: false
  };
}

async function renderOpportunities() {
  const list = document.getElementById('opportunities-list');
  if (!list) return;
  const token = localStorage.getItem('alumnet_token');
  if (!token) return;

  list.innerHTML = '<p style="color:var(--slate); padding:20px 4px;">Loading opportunities...</p>';
  try {
    const res = await fetch(`${API_BASE}/opportunities`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!res.ok) {
      list.innerHTML = `<p style="color:var(--kq-red); padding:20px 4px;">${escapeHTML(data.error || 'Could not load opportunities.')}</p>`;
      return;
    }
    allOpportunities = data;
    drawOpportunities();
  } catch {
    list.innerHTML = '<p style="color:var(--kq-red); padding:20px 4px;">Could not reach the server.</p>';
  }
}

function drawOpportunities() {
  const list = document.getElementById('opportunities-list');
  if (!list) return;

  const q = (document.getElementById('opp-search')?.value || '').toLowerCase().trim();
  const industry = document.getElementById('opp-industry')?.value || '';
  const type = document.getElementById('opp-type')?.value || '';

  const filtered = allOpportunities.filter((o) => {
    if (industry && o.industry !== industry) return false;
    if (type && o.opportunity_type !== type) return false;
    if (q) {
      const haystack = `${o.title} ${o.company || ''} ${o.description || ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  if (!filtered.length) {
    list.innerHTML = `<p style="color:var(--slate); padding:20px 4px;">${allOpportunities.length ? 'No opportunities match your filters.' : 'No open opportunities right now.'
      }</p>`;
    return;
  }

  list.innerHTML = filtered.map(opportunityCardHTML).join('');
  list.querySelectorAll('[data-view-opp]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const opp = allOpportunities.find((o) => String(o.opportunity_id) === btn.dataset.viewOpp);
      if (opp) openOpportunityModal(opp);
    });
  });
}

function opportunityCardHTML(o) {
  const closing = closingLabel(o.closing_date);
  return `
    <div class="opportunity-card">
      <div>
        <div class="opp-tags">
          <span class="tag">${escapeHTML(OPPORTUNITY_TYPES[o.opportunity_type] || 'Opportunity')}</span>
          ${o.industry ? `<span class="tag">${escapeHTML(o.industry)}</span>` : ''}
          ${closing.soon ? `<span class="tag closing-soon">${closing.text}</span>` : ''}
        </div>
        <h3 style="font-size:1rem; margin:8px 0 2px;">${escapeHTML(o.title)}</h3>
        <div class="opp-company">${escapeHTML(o.company || '')}${o.location ? ' · ' + escapeHTML(o.location) : ''}</div>
        <p class="mentor-blurb">${escapeHTML(truncate(o.description, 160))}</p>
        <div class="mentor-meta">Posted by ${escapeHTML(o.posted_by_name)}${!closing.soon && closing.text ? ' · ' + closing.text : ''}</div>
      </div>
      <button class="btn btn-secondary" data-view-opp="${o.opportunity_id}">View</button>
    </div>`;
}

function openOpportunityModal(o) {
  const link = (o.apply_link || '').trim();
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(link);
  const href = isEmail ? `mailto:${link}` : (/^https?:\/\//i.test(link) ? link : '');
  const closing = closingLabel(o.closing_date);

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal-card">
      <h3>${escapeHTML(o.title)}</h3>
      <div class="modal-meta">${escapeHTML(o.company || '')}${o.location ? ' · ' + escapeHTML(o.location) : ''}</div>
      <div class="modal-section"><div class="label">Type</div><div class="value">${escapeHTML(OPPORTUNITY_TYPES[o.opportunity_type] || 'Opportunity')}${o.industry ? ' · ' + escapeHTML(o.industry) : ''}</div></div>
      <div class="modal-section"><div class="label">Description</div><div class="value" style="white-space:pre-line;">${escapeHTML(o.description || '')}</div></div>
      ${closing.text ? `<div class="modal-section"><div class="label">Closing date</div><div class="value">${closing.text}</div></div>` : ''}
      <div class="modal-section"><div class="label">Posted by</div><div class="value">${escapeHTML(o.posted_by_name)}${o.posted_by_department ? ', ' + escapeHTML(o.posted_by_department) : ''}</div></div>
      ${href
      ? `<a class="btn btn-primary btn-block" href="${escapeHTML(href)}" target="_blank" rel="noopener" style="margin-bottom:10px;">${isEmail ? 'Apply by email' : 'Apply now'}</a>`
      : '<p class="mentor-meta" style="margin-bottom:10px;">No application link was provided.</p>'}
      <button class="btn btn-secondary btn-block" id="close-opp-modal">Close</button>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  backdrop.querySelector('#close-opp-modal').addEventListener('click', () => backdrop.remove());
}

// Runs once per page load: filters, plus posting for mentors
function wireOpportunitiesPage() {
  ['opp-search', 'opp-industry', 'opp-type'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', drawOpportunities);
  });

  const postBtn = document.getElementById('post-opportunity-btn');
  if (postBtn && localStorage.getItem('alumnet_role') === 'mentor') {
    postBtn.addEventListener('click', openPostOpportunityModal);
    renderMyPosts();
  }
}

function openPostOpportunityModal() {
  const token = localStorage.getItem('alumnet_token');
  const today = new Date().toLocaleDateString('en-CA');
  const typeOptions = Object.entries(OPPORTUNITY_TYPES)
    .map(([value, label]) => `<option value="${value}">${label}</option>`).join('');

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal-card">
      <h3>Post an opportunity</h3>
      <div class="modal-meta">Opportunities are reviewed by the admin before they appear to the network.</div>
      <form id="post-opp-form" novalidate>
        <div class="field"><label for="poTitle">Role title</label><input type="text" id="poTitle" placeholder="e.g. Cabin Safety Trainer"></div>
        <div class="field"><label for="poCompany">Company or department</label><input type="text" id="poCompany" placeholder="e.g. KQ Training Academy"></div>
        <div class="field-row">
          <div class="field"><label for="poType">Type</label><select id="poType">${typeOptions}</select></div>
          <div class="field">
            <label for="poIndustry">Industry</label>
            <select id="poIndustry">
              <option>Aviation</option><option>Ground Operations</option><option>Logistics</option>
              <option>Corporate / Support</option><option>Other</option>
            </select>
          </div>
        </div>
        <div class="field-row">
          <div class="field"><label for="poLocation">Location</label><input type="text" id="poLocation" placeholder="e.g. Nairobi or Remote"></div>
          <div class="field"><label for="poClosing">Closing date</label><input type="date" id="poClosing" min="${today}"></div>
        </div>
        <div class="field"><label for="poLink">Application link or contact email</label><input type="text" id="poLink" placeholder="https://... or name@example.com"></div>
        <div class="field"><label for="poDescription">Description</label><textarea id="poDescription" placeholder="What the role involves and who it suits"></textarea></div>
        <p id="po-error" style="color:var(--kq-red); font-size:0.85rem; display:none; margin-bottom:12px;"></p>
        <div style="display:flex; gap:10px;">
          <button type="submit" class="btn btn-primary">Submit for review</button>
          <button type="button" class="btn btn-secondary" id="po-cancel">Cancel</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('#po-cancel').addEventListener('click', close);

  backdrop.querySelector('#post-opp-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = backdrop.querySelector('#po-error');
    errorEl.style.display = 'none';

    const payload = {
      title: backdrop.querySelector('#poTitle').value,
      company: backdrop.querySelector('#poCompany').value,
      opportunityType: backdrop.querySelector('#poType').value,
      industry: backdrop.querySelector('#poIndustry').value,
      location: backdrop.querySelector('#poLocation').value,
      closingDate: backdrop.querySelector('#poClosing').value,
      applyLink: backdrop.querySelector('#poLink').value,
      description: backdrop.querySelector('#poDescription').value
    };

    try {
      const res = await fetch(`${API_BASE}/opportunities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload)
      });
      const result = await res.json();
      if (!res.ok) {
        errorEl.textContent = result.error || 'Could not submit the opportunity';
        errorEl.style.display = 'block';
        return;
      }
      close();
      renderMyPosts();
    } catch {
      errorEl.textContent = 'Could not reach the server.';
      errorEl.style.display = 'block';
    }
  });
}

async function renderMyPosts() {
  const mount = document.getElementById('my-posts');
  if (!mount) return;
  const token = localStorage.getItem('alumnet_token');

  try {
    const res = await fetch(`${API_BASE}/opportunities/mine`, { headers: { Authorization: `Bearer ${token}` } });
    const rows = await res.json();
    if (!res.ok || !rows.length) { mount.innerHTML = ''; return; }

    mount.innerHTML = `
      <div class="section-heading"><h2>Your posts</h2></div>
      ${rows.map((p) => `
        <div class="request-card">
          <div>
            <strong>${escapeHTML(p.title)}</strong><br>
            <span style="font-size:0.82rem; color:var(--slate);">
              ${escapeHTML(p.company || '')}${p.closing_date ? ' · ' + closingLabel(p.closing_date).text : ''}
            </span>
          </div>
          <span class="request-status ${p.approval_status}">${p.approval_status}</span>
        </div>`).join('')}`;
  } catch {
    mount.innerHTML = '';
  }
}

/* --------------------------------------------------------------------
   Admin dashboard (FR-12)
   -------------------------------------------------------------------- */

let allAdminUsers = [];

async function renderAdminTable() {
  const statRow = document.getElementById('stat-row');
  const tbody = document.getElementById('admin-table-body');
  if (!statRow || !tbody) return;
  const token = localStorage.getItem('alumnet_token');
  if (!token) return;

  try {
    const [statsRes, usersRes] = await Promise.all([
      fetch(`${API_BASE}/admin/stats`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${API_BASE}/admin/users`, { headers: { Authorization: `Bearer ${token}` } })
    ]);
    const stats = await statsRes.json();
    const users = await usersRes.json();

    if (!statsRes.ok || !usersRes.ok) {
      tbody.innerHTML = `<tr><td colspan="7">${escapeHTML(stats.error || users.error || 'Could not load admin data.')}</td></tr>`;
      return;
    }

    statRow.innerHTML = `
      <div class="stat-card"><div class="num">${stats.totalAlumni}</div><div class="label">Total alumni</div></div>
      <div class="stat-card"><div class="num">${stats.activeMentorships}</div><div class="label">Active mentorships</div></div>
      <div class="stat-card"><div class="num">${stats.pendingRequests}</div><div class="label">Pending requests</div></div>
      <div class="stat-card"><div class="num">${stats.flaggedAccounts}</div><div class="label">Flagged accounts</div></div>`;

    allAdminUsers = users;
    tbody.innerHTML = users.map(adminRowHTML).join('');
    wireAdminActions(tbody);
  } catch {
    tbody.innerHTML = '<tr><td colspan="7">Could not reach the server.</td></tr>';
  }
}

function adminRowHTML(u) {
  const isSuspended = u.status === 'suspended';
  const roleLabel = { mentor: 'Mentor', mentee: 'Mentee', admin: 'Admin' }[u.role] || 'No role';
  const lastActive = u.last_login_at ? timeAgo(u.last_login_at) : 'Never';
  return `
    <tr>
      <td><strong>${escapeHTML(u.name)}</strong><br><span class="md-muted st-small">${escapeHTML(u.email)}${u.staff_number ? ' · ' + escapeHTML(u.staff_number) : ''}</span></td>
      <td>${roleLabel}${u.employment_status ? `<br><span class="md-muted st-small">${u.employment_status === 'former' ? 'Former staff' : 'Current staff'}</span>` : ''}</td>
      <td>${escapeHTML(u.department || '')}</td>
      <td><span class="md-pill ${isSuspended ? 'rejected' : 'approved'}">${isSuspended ? 'Suspended' : 'Active'}</span></td>
      <td>${lastActive}</td>
      <td>${u.totp_enabled ? 'On' : '<span class="md-muted">Off</span>'}</td>
      <td>${u.role === 'admin' ? '' : `<button class="btn btn-secondary md-btn-sm" data-action="toggle-status" data-user-id="${u.user_id}" data-name="${escapeHTML(u.name)}" data-suspended="${isSuspended ? 1 : 0}">
        ${isSuspended ? 'Reactivate' : 'Suspend'}
      </button>`}</td>
    </tr>`;
}

function wireAdminActions(tbody) {
  tbody.querySelectorAll('[data-action="toggle-status"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const suspending = btn.dataset.suspended === '0';
      let reason = '';
      if (suspending) {
        reason = prompt(`Why are you suspending ${btn.dataset.name}? They will see this reason.`, '');
        if (reason === null) return;
        reason = reason.trim();
        if (!reason) { alert('Give a short reason so the member knows why.'); return; }
      } else if (!confirm(`Reactivate ${btn.dataset.name}?`)) {
        return;
      }
      btn.disabled = true;
      try {
        const res = await fetch(`${API_BASE}/admin/users/${btn.dataset.userId}/toggle-status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason })
        });
        const result = await res.json();
        if (!res.ok) { alert(result.error || 'Action failed'); btn.disabled = false; return; }
        renderAdminTable();
        renderAdminLogs();
      } catch {
        alert('Could not reach the server.');
        btn.disabled = false;
      }
    });
  });
}

function wireAdminSearch() {
  const input = document.getElementById('admin-user-search');
  if (!input) return;
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    const filtered = allAdminUsers.filter((u) =>
      [u.name, u.email, u.staff_number, u.department, u.role].some((v) => String(v || '').toLowerCase().includes(q)));
    const tbody = document.getElementById('admin-table-body');
    tbody.innerHTML = filtered.length ? filtered.map(adminRowHTML).join('') : '<tr><td colspan="7" class="md-muted">No members match that search.</td></tr>';
    wireAdminActions(tbody);
  });
}

/* ---------- Identity verification queue ---------- */

async function renderAdminVerification() {
  const list = document.getElementById('admin-verification-list');
  if (!list) return;
  const res = await fetch(`${API_BASE}/admin/signup-requests`);
  const rows = await res.json().catch(() => []);
  if (!res.ok) { list.innerHTML = `<p class="md-muted">${escapeHTML(rows.error || 'Could not load sign-up requests.')}</p>`; return; }
  updateVerificationBadge(rows.length);
  if (!rows.length) {
    list.innerHTML = mdEmpty('check', 'Nobody waiting', 'Sign-ups that match HR records are verified automatically. Only the rest appear here.');
    return;
  }
  const riskText = { low: 'Low risk', medium: 'Check first', high: 'High risk' };
  list.innerHTML = rows.map((r) => `
    <article class="vr-card" data-request="${r.request_id}">
      <div class="vr-head">
        <div>
          <h3>${escapeHTML(r.full_name)} <span class="md-muted st-small">${escapeHTML(r.staff_number)}</span></h3>
          <div class="md-muted st-small">Requested ${timeAgo(r.created_at)}${r.role_if_approved ? ' · would join as ' + r.role_if_approved : ''}</div>
        </div>
        <span class="md-pill risk-${r.risk_level}">${riskText[r.risk_level] || r.risk_level}</span>
      </div>
      <dl class="vr-cols">
        <div><dt>Entered</dt><dd>${escapeHTML(r.full_name)}<br>${escapeHTML(r.email)} (confirmed)<br>${escapeHTML(r.phone || '')}</dd></div>
        <div><dt>HR record</dt><dd>${r.hr_name ? `${escapeHTML(r.hr_name)}<br>${escapeHTML(r.hr_department || '')}, ${r.hr_status === 'former' ? 'former staff' : 'current staff'}<br>${escapeHTML(r.hr_phone || 'No phone on record')}` : 'No HR record for this staff number'}</dd></div>
      </dl>
      <ul class="vr-signals">${r.signals.map((s) => `<li class="${s.ok ? 'ok' : 'bad'}">${escapeHTML(s.label)}</li>`).join('')}</ul>
      ${r.suggestion ? `<p class="vr-suggest ${r.risk_level}">${escapeHTML(r.suggestion)}</p>` : ''}
      <div class="field" style="margin-bottom:10px;">
        <label for="vr-note-${r.request_id}">Note (required to reject; the person is not shown it)</label>
        <input type="text" id="vr-note-${r.request_id}" maxlength="255" placeholder="e.g. Confirmed by phone on HR number">
      </div>
      <p class="st-msg" id="vr-msg-${r.request_id}"></p>
      <div class="md-inline-actions">
        <button class="btn btn-primary md-btn-sm" data-vr="${r.request_id}" data-decision="approved" ${r.hr_name ? '' : 'disabled'}>Approve</button>
        <button class="btn btn-secondary md-btn-sm" data-vr="${r.request_id}" data-decision="rejected">Reject</button>
      </div>
    </article>`).join('');

  list.querySelectorAll('[data-vr]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.vr;
      const note = document.getElementById(`vr-note-${id}`).value.trim();
      const msg = document.getElementById(`vr-msg-${id}`);
      if (btn.dataset.decision === 'rejected' && !note) { setMsg(msg, 'Add a short note saying why you are rejecting.'); return; }
      if (btn.dataset.decision === 'approved' && !confirm('Approve this person? Their account is created from the HR record.')) return;
      btn.closest('.vr-card').querySelectorAll('button').forEach((b) => (b.disabled = true));
      const { ok, data } = await apiSend('PATCH', `/admin/signup-requests/${id}/review`, { decision: btn.dataset.decision, note });
      if (!ok) {
        setMsg(msg, data.error);
        btn.closest('.vr-card').querySelectorAll('button').forEach((b) => (b.disabled = false));
        return;
      }
      renderAdminVerification();
      renderAdminLogs();
      renderAdminTable();
    });
  });
}

function updateVerificationBadge(count) {
  document.querySelectorAll('[data-admin-tab="verification"], a[href="admin.html#verification"]').forEach((link) => {
    let badge = link.querySelector('.nav-badge');
    if (!count) { if (badge) badge.remove(); return; }
    if (!badge) { badge = document.createElement('span'); badge.className = 'nav-badge'; link.appendChild(badge); }
    badge.textContent = count;
  });
}

/* ---------- HR records import ---------- */

// Small CSV reader: handles quoted values with commas and doubled quotes
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/^﻿/, '').replace(/\s+/g, '_'));
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}

function wireHrImport() {
  const input = document.getElementById('hr-file');
  if (!input) return;
  const msg = document.getElementById('hr-msg');
  const preview = document.getElementById('hr-preview');
  let rows = null;

  const list = (items, fmt) => items.length
    ? `<ul class="vr-signals">${items.slice(0, 20).map((x) => `<li class="bad">${fmt(x)}</li>`).join('')}${items.length > 20 ? `<li>and ${items.length - 20} more</li>` : ''}</ul>`
    : '';

  input.addEventListener('change', async () => {
    setMsg(msg, '');
    preview.innerHTML = '';
    const file = input.files[0];
    if (!file) return;
    if (file.size > 1.5 * 1024 * 1024) { setMsg(msg, 'That file is too large. Split it into smaller files.'); return; }
    rows = parseCSV(await file.text());
    if (!rows.length) { setMsg(msg, 'No rows found in that file.'); return; }
    if (!('staff_number' in rows[0]) || !('employment_status' in rows[0])) {
      setMsg(msg, 'The file needs at least staff_number and employment_status columns.');
      return;
    }
    const { ok, data } = await apiSend('POST', '/admin/hr/preview', { rows });
    if (!ok) { setMsg(msg, data.error); return; }
    preview.innerHTML = `
      <div class="hr-summary">
        <div><strong>${data.added.length}</strong><span>New staff</span></div>
        <div><strong>${data.updated.length}</strong><span>Updated</span></div>
        <div><strong>${data.unchanged}</strong><span>Unchanged</span></div>
        <div><strong>${data.retiring.length}</strong><span>Now former staff</span></div>
        <div><strong>${data.invalid.length}</strong><span>Rows with problems</span></div>
      </div>
      ${data.retiring.length ? `<p class="st-text"><strong>These members become mentors.</strong> Their open requests as mentees will be closed and they will be told why.</p>${list(data.retiring, (x) => `${escapeHTML(x.full_name)} (${escapeHTML(x.staff_number)})`).replace(/class="bad"/g, '')}` : ''}
      ${data.ineligible.length ? `<p class="st-text"><strong>These members lose access</strong> because HR marks them not eligible.</p>${list(data.ineligible, (x) => `${escapeHTML(x.full_name)} (${escapeHTML(x.staff_number)})`)}` : ''}
      ${data.invalid.length ? `<p class="st-text"><strong>Skipped rows:</strong></p>${list(data.invalid, (x) => `Line ${x.line}${x.staff_number ? ' (' + escapeHTML(x.staff_number) + ')' : ''}: ${escapeHTML(x.errors.join(', '))}`)}` : ''}
      <div class="st-actions">
        <button type="button" class="btn-quiet" id="hr-cancel">Cancel</button>
        <button type="button" class="btn btn-primary md-btn-sm" id="hr-apply" ${data.added.length + data.updated.length ? '' : 'disabled'}>Apply changes</button>
      </div>`;
    document.getElementById('hr-cancel').onclick = () => { preview.innerHTML = ''; input.value = ''; rows = null; };
    document.getElementById('hr-apply').onclick = async () => {
      const btn = document.getElementById('hr-apply');
      btn.disabled = true;
      btn.textContent = 'Applying...';
      const r = await apiSend('POST', '/admin/hr/apply', { rows });
      if (!r.ok) { setMsg(msg, r.data.error); btn.disabled = false; btn.textContent = 'Apply changes'; return; }
      preview.innerHTML = '';
      input.value = '';
      setMsg(msg, `Done: ${r.data.summary}.`, true);
      renderAdminTable();
      renderAdminLogs();
    };
  });
}

/* Admin tools need 2FA: show one clear message instead of empty tabs */
async function checkAdminTwoFactor() {
  const banner = document.getElementById('admin-2fa-required');
  if (!banner) return;
  try {
    const res = await fetch(`${API_BASE}/admin/stats`);
    if (res.status !== 403) return;
    const data = await res.json();
    if (data.code !== 'two_factor_required') return;
    banner.style.display = 'block';
    document.querySelectorAll('[id^="admin-tab-"]').forEach((el) => { el.style.opacity = '0.35'; el.style.pointerEvents = 'none'; });
  } catch { /* offline */ }
}


const ADMIN_TABS = ['overview', 'verification', 'users', 'hr', 'events', 'opportunities', 'logs'];

function showAdminTab(name) {
  ADMIN_TABS.forEach((t) => {
    const el = document.getElementById(`admin-tab-${t}`);
    if (el) el.style.display = t === name ? 'block' : 'none';
  });
  document.querySelectorAll('[data-admin-tab]').forEach((l) => {
    l.classList.toggle('active', l.dataset.adminTab === name);
  });
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  window.scrollTo(0, 0);
}

function wireAdminTabs() {
  const tabLinks = document.querySelectorAll('[data-admin-tab]');
  if (!tabLinks.length) return;
  tabLinks.forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      showAdminTab(link.dataset.adminTab);
    });
  });
  // Links inside the overview that jump to another tab
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-goto-tab]');
    if (!go) return;
    e.preventDefault();
    showAdminTab(go.dataset.gotoTab);
  });
  const fromHash = location.hash.slice(1);
  showAdminTab(ADMIN_TABS.includes(fromHash) ? fromHash : 'overview');
}

async function renderAdminEvents() {
  const tbody = document.getElementById('admin-events-body');
  if (!tbody) return;
  const token = localStorage.getItem('alumnet_token');

  const res = await fetch(`${API_BASE}/admin/events`, { headers: { Authorization: `Bearer ${token}` } });
  const events = await res.json();
  if (!res.ok) { tbody.innerHTML = `<tr><td colspan="5">${escapeHTML(events.error)}</td></tr>`; return; }

  tbody.innerHTML = events.map((e) => `
    <tr>
      <td>${escapeHTML(e.title)}</td>
      <td>${new Date(e.event_date).toLocaleString('en-GB')}</td>
      <td>${escapeHTML(e.description || '')}</td>
      <td><span class="request-status ${e.status}">${e.status}</span></td>
      <td><button class="btn btn-secondary" data-delete-event="${e.event_id}">Delete</button></td>
    </tr>`).join('');

  tbody.querySelectorAll('[data-delete-event]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this event?')) return;
      await fetch(`${API_BASE}/admin/events/${btn.dataset.deleteEvent}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
      });
      renderAdminEvents();
      renderAdminLogs();
    });
  });
}

function wireAdminEventForm() {
  const form = document.getElementById('create-event-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = localStorage.getItem('alumnet_token');
    const errorEl = document.getElementById('event-form-error');
    if (errorEl) errorEl.style.display = 'none';

    const payload = {
      title: document.getElementById('eventTitle').value,
      eventDate: document.getElementById('eventDate').value,
      description: document.getElementById('eventDescription').value,
      mode: document.getElementById('eventMode').value,
      location: document.getElementById('eventLocation').value,
      capacity: document.getElementById('eventCapacity').value || null
    };

    const res = await fetch(`${API_BASE}/admin/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      form.reset();
      document.getElementById('eventDescription').value = '';
      renderAdminEvents();
      renderAdminLogs();
    } else if (errorEl) {
      const err = await res.json();
      errorEl.textContent = err.error || 'Could not create event';
      errorEl.style.display = 'block';
    }
  });
}

async function renderAdminOpportunities() {
  const list = document.getElementById('admin-opportunities-list');
  if (!list) return;
  const token = localStorage.getItem('alumnet_token');

  const res = await fetch(`${API_BASE}/admin/opportunities/pending`, { headers: { Authorization: `Bearer ${token}` } });
  const opps = await res.json();
  if (!res.ok) { list.innerHTML = `<p>${opps.error}</p>`; return; }
  if (!opps.length) { list.innerHTML = '<p style="color:var(--slate); padding:20px 4px;">Nothing pending review.</p>'; return; }

  list.innerHTML = opps.map((o) => `
    <div class="opportunity-card">
      <div>
        <div class="opp-tags">
          <span class="tag">${escapeHTML(OPPORTUNITY_TYPES[o.opportunity_type] || 'Opportunity')}</span>
          ${o.industry ? `<span class="tag">${escapeHTML(o.industry)}</span>` : ''}
        </div>
        <h3 style="font-size:1rem; margin:8px 0 2px;">${escapeHTML(o.title)}</h3>
        <div class="opp-company">${escapeHTML(o.company || '')}${o.location ? ' · ' + escapeHTML(o.location) : ''}</div>
        <p class="mentor-blurb">${escapeHTML(o.description || '')}</p>
        <div class="mentor-meta">
          Posted by ${escapeHTML(o.posted_by_name)}${o.closing_date ? ' · ' + closingLabel(o.closing_date).text : ''}
          ${o.apply_link ? ' · Apply: ' + escapeHTML(o.apply_link) : ''}
        </div>
      </div>
      <div style="display:flex; gap:8px;">
        <button class="btn btn-primary" data-review="${o.opportunity_id}" data-decision="approved">Approve</button>
        <button class="btn btn-secondary" data-review="${o.opportunity_id}" data-decision="rejected">Reject</button>
      </div>
    </div>`).join('');

  list.querySelectorAll('[data-review]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(`${API_BASE}/admin/opportunities/${btn.dataset.review}/review`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ decision: btn.dataset.decision })
      });
      renderAdminOpportunities();
      renderAdminLogs();
    });
  });
}

const ADMIN_ACTION_LABELS = {
  suspend_user: 'Suspended', reactivate_user: 'Reactivated',
  approve_signup: 'Sign-up approved', reject_signup: 'Sign-up rejected', import_hr: 'HR import',
  create_event: 'Event created', delete_event: 'Event deleted',
  approved_event: 'Event approved', rejected_event: 'Event rejected',
  approved_opportunity: 'Opportunity approved', rejected_opportunity: 'Opportunity rejected'
};

async function renderAdminLogs() {
  const tbody = document.getElementById('admin-logs-body');
  if (!tbody) return;
  const token = localStorage.getItem('alumnet_token');

  const res = await fetch(`${API_BASE}/admin/activity-logs`, { headers: { Authorization: `Bearer ${token}` } });
  const logs = await res.json();
  if (!res.ok) { tbody.innerHTML = `<tr><td colspan="4">${escapeHTML(logs.error)}</td></tr>`; return; }
  if (!logs.length) { tbody.innerHTML = '<tr><td colspan="4" class="md-muted">No admin activity yet.</td></tr>'; return; }

  tbody.innerHTML = logs.map((l) => `
    <tr>
      <td>${new Date(l.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
      <td>${escapeHTML(l.admin_name)}</td>
      <td><span class="tag" style="white-space:nowrap;">${escapeHTML(ADMIN_ACTION_LABELS[l.action_type] || mdHumanise(l.action_type))}</span></td>
      <td>${escapeHTML(l.description || l.target_label || '')}</td>
    </tr>`).join('');
}

/* --------------------------------------------------------------------
   Notifications
   -------------------------------------------------------------------- */

// Escapes user-supplied text before it goes into innerHTML
function escapeHTML(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function timeAgo(dateStr) {
  const seconds = Math.floor((Date.now() - new Date(dateStr)) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

async function renderNotifications() {
  const list = document.getElementById('notif-list');
  if (!list) return;
  const token = localStorage.getItem('alumnet_token');
  if (!token) return;

  try {
    const res = await fetch(`${API_BASE}/notifications`, { headers: { Authorization: `Bearer ${token}` } });
    const rows = await res.json();
    if (!res.ok) {
      list.innerHTML = `<p style="color:var(--kq-red); padding:20px 4px;">${rows.error || 'Could not load notifications.'}</p>`;
      return;
    }
    if (!rows.length) {
      list.innerHTML = '<p style="color:var(--slate); padding:20px 4px;">No notifications yet. Updates on your mentorships and events will appear here.</p>';
      return;
    }

    list.innerHTML = rows.map((n) => `
      <div class="notif-item ${n.is_read ? '' : 'unread'}" data-notif-id="${n.notification_id}" data-link="${escapeHTML(n.link || '')}" role="button" tabindex="0">
        <span class="notif-dot" style="${n.is_read ? 'background:transparent;' : ''}"></span>
        <div>
          <div>${escapeHTML(n.message)}</div>
          <div class="mentor-meta">${timeAgo(n.created_at)}</div>
        </div>
      </div>`).join('');

    list.querySelectorAll('[data-notif-id]').forEach((item) => {
      item.addEventListener('click', async () => {
        await fetch(`${API_BASE}/notifications/${item.dataset.notifId}/read`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}` }
        });
        if (item.dataset.link) {
          window.location.href = item.dataset.link;
        } else {
          renderNotifications();
          updateNotifBadge();
        }
      });
    });
  } catch {
    list.innerHTML = '<p style="color:var(--kq-red); padding:20px 4px;">Could not reach the server.</p>';
  }
}

function wireMarkAllRead() {
  const btn = document.getElementById('mark-all-read-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    await fetch(`${API_BASE}/notifications/read-all`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${localStorage.getItem('alumnet_token')}` }
    });
    btn.disabled = false;
    renderNotifications();
    updateNotifBadge();
  });
}

// Red unread count on the Notifications link in the sidebar
async function updateNotifBadge() {
  const link = document.querySelector('#sidebar-nav a[href="notifications.html"]');
  const token = localStorage.getItem('alumnet_token');
  if (!link || !token) return;
  try {
    const res = await fetch(`${API_BASE}/notifications/unread-count`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const { count } = await res.json();
    let badge = link.querySelector('.nav-badge');
    if (!count) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'nav-badge';
      link.appendChild(badge);
    }
    badge.textContent = count > 99 ? '99+' : count;
  } catch { }
}

function wireSidebarToggle() {
  const btn = document.getElementById('hamburger-btn');
  const sidebar = document.querySelector('.app-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (!btn || !sidebar || !backdrop) return;

  function closeSidebar() {
    sidebar.classList.remove('open');
    backdrop.classList.remove('visible');
    btn.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }

  btn.addEventListener('click', () => {
    const isOpen = sidebar.classList.toggle('open');
    backdrop.classList.toggle('visible', isOpen);
    btn.classList.toggle('open', isOpen);
    btn.setAttribute('aria-expanded', String(isOpen));
  });

  backdrop.addEventListener('click', closeSidebar);
  sidebar.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeSidebar));
}

/* ===================== Mentor dashboard ===================== */

// Accepts either a plain array or an object that wraps one
function mdList(x) {
  if (Array.isArray(x)) return x;
  if (x && typeof x === 'object') {
    for (const k of ['data', 'requests', 'events', 'proposals', 'posts', 'items', 'results']) {
      if (Array.isArray(x[k])) return x[k];
    }
  }
  return [];
}

function mdInitials(name) {
  return (name || '?').split(' ').filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

function mdIcon(paths) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const MD_ICONS = {
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  award: '<circle cx="12" cy="8" r="6"/><path d="M15.48 12.89 17 22l-5-3-5 3 1.52-9.11"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  dot: '<circle cx="12" cy="12" r="4"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  spark: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>'
};

function mdEmpty(icon, title, text, linkHref, linkText) {
  return `
    <div class="md-empty">
      <div class="md-empty-icon">${mdIcon(MD_ICONS[icon])}</div>
      <div>
        <div class="md-empty-title">${title}</div>
        <div class="md-empty-text">${text}</div>
        ${linkHref ? `<a href="${linkHref}" class="md-link">${linkText}</a>` : ''}
      </div>
    </div>`;
}

function mdDate(value) {
  const d = new Date(value);
  return isNaN(d) ? null : d;
}

async function renderMentorDashboard() {
  const root = document.getElementById('mentor-dashboard');
  if (!root) return;

  // Only mentors belong here; send anyone else to their own home page
  const role = localStorage.getItem('alumnet_role');
  if (role && role !== 'mentor') {
    window.location.href = (typeof HOME_PAGE !== 'undefined' && HOME_PAGE[role]) || 'login.html';
    return;
  }

  const token = localStorage.getItem('alumnet_token');
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const get = async (path) => {
    try {
      const res = await fetch(`${API_BASE}${path}`, auth);
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };

  const [profileRaw, reqRaw, eventsRaw, propRaw, postRaw] = await Promise.all([
    get('/profile/me'),
    get('/mentorship-requests'),
    get('/events'),
    get('/events/my-proposals'),
    get('/opportunities/mine')
  ]);

  const profile = (profileRaw && (profileRaw.profile || profileRaw)) || {};
  const requests = mdList(reqRaw);
  const events = mdList(eventsRaw);
  const proposals = mdList(propRaw);
  const posts = mdList(postRaw);

  const nameOf = (r) => r.other_name || r.mentee_name || r.name || 'A mentee';
  const deptOf = (r) => r.other_department || r.mentee_department || r.department || '';

  const pending = requests.filter((r) => r.status === 'pending');
  const active = requests.filter((r) => r.status === 'accepted');
  const ended = requests.filter((r) => r.status === 'ended');
  const registered = events.filter((e) => e.is_registered || e.registered || e.user_registered);

  // ---------- Header ----------
  const hour = new Date().getHours();
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const fullName = profile.name || localStorage.getItem('alumnet_name') || '';
  const first = fullName.split(' ')[0];
  document.getElementById('md-date').textContent = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
  document.getElementById('md-greeting').textContent = first ? `${part}, ${first}` : part;
  document.getElementById('md-sub').textContent =
    pending.length ? `You have ${pending.length} mentee request${pending.length === 1 ? '' : 's'} waiting for your response.`
      : active.length ? `You are mentoring ${active.length} staff member${active.length === 1 ? '' : 's'}. No new requests right now.`
        : 'Your dashboard will fill up as mentees connect with you.';

  // ---------- Matching nudge ----------
  if (missingMatchingFields(profile).length) {
    document.getElementById('md-nudge').innerHTML = `
      <div class="md-banner">
        <div class="md-banner-icon">${mdIcon(MD_ICONS.spark)}</div>
        <div class="md-banner-body">
          <strong>Mentees can't find you yet</strong>
          <p>Matches are based on your skills, experience and career interests. Add them so the right mentees are matched with you.</p>
        </div>
        <a href="profile.html#edit" class="btn btn-primary">Complete profile</a>
      </div>`;
  }

  // ---------- Stat cards ----------
  const kpi = (icon, num, label, sub, cls = '') => `
    <div class="md-kpi ${cls}">
      <div class="md-kpi-icon">${mdIcon(MD_ICONS[icon])}</div>
      <div class="md-kpi-num">${num}</div>
      <div class="md-kpi-label">${label}</div>
      ${sub ? `<div class="md-kpi-sub">${sub}</div>` : ''}
    </div>`;
  document.getElementById('md-kpis').innerHTML =
    kpi('inbox', pending.length, 'Awaiting your response', pending.length ? 'Action needed' : 'All caught up', pending.length ? 'alert' : '') +
    kpi('users', active.length, `Active mentee${active.length === 1 ? '' : 's'}`, '') +
    kpi('award', active.length + ended.length, 'Mentored in total', ended.length ? `${ended.length} completed` : '') +
    kpi('calendar', registered.length, 'Events you are attending', '');

  // ---------- Pending requests ----------
  document.getElementById('md-pending').innerHTML = pending.length
    ? pending.slice(0, 4).map((r) => {
      const msg = r.message || r.request_message || r.note || '';
      const when = r.created_at || r.requested_at;
      return `
          <div class="md-item">
            <div class="md-avatar">${mdInitials(nameOf(r))}</div>
            <div class="md-item-body">
              <div class="md-item-title">${escapeHTML(nameOf(r))}${deptOf(r) ? `<span class="md-muted"> · ${escapeHTML(deptOf(r))}</span>` : ''}</div>
              ${msg ? `<div class="md-item-text">${escapeHTML(msg.length > 110 ? msg.slice(0, 110) + '...' : msg)}</div>` : ''}
              ${when ? `<div class="md-item-meta">Requested ${timeAgo(when)}</div>` : ''}
            </div>
            <a href="requests.html" class="btn btn-primary md-btn-sm">Review</a>
          </div>`;
    }).join('') + (pending.length > 4 ? `<a href="requests.html" class="md-link md-more">See ${pending.length - 4} more</a>` : '')
    : mdEmpty('check', "You're all caught up", 'New requests from mentees will appear here.');

  // ---------- Active mentees ----------
  document.getElementById('md-mentees').innerHTML = active.length
    ? active.map((r) => {
      const since = mdDate(r.responded_at || r.updated_at || r.created_at);
      return `
          <div class="md-item">
            <div class="md-avatar md-avatar-soft">${mdInitials(nameOf(r))}</div>
            <div class="md-item-body">
              <div class="md-item-title">${escapeHTML(nameOf(r))}</div>
              <div class="md-item-meta">${escapeHTML(deptOf(r))}${since ? `${deptOf(r) ? ' · ' : ''}Mentoring since ${since.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}</div>
            </div>
            <span class="md-pill approved">Active</span>
          </div>`;
    }).join('')
    : mdEmpty('users', 'No active mentees yet', 'When you accept a request, the mentee appears here.');

  // ---------- Profile strength ----------
  document.getElementById('md-profile').innerHTML = profileStrengthHTML(profile, { showCta: true });

  // ---------- Upcoming events ----------
  const byDate = (a, b) => (mdDate(a.event_date || a.date) || 0) - (mdDate(b.event_date || b.date) || 0);
  const showEvents = (registered.length ? registered : events).slice().sort(byDate).slice(0, 3);
  document.getElementById('md-events').innerHTML = showEvents.length
    ? (!registered.length ? '<div class="md-hint">Happening soon</div>' : '') + showEvents.map((e) => {
      const d = mdDate(e.event_date || e.date);
      const mode = e.mode === 'virtual' ? 'Virtual' : (e.location || 'In person');
      return `
          <a class="md-event" href="events.html">
            <div class="md-date-block">
              <span class="m">${d ? d.toLocaleDateString('en-GB', { month: 'short' }) : '--'}</span>
              <span class="d">${d ? d.getDate() : '--'}</span>
            </div>
            <div class="md-item-body">
              <div class="md-item-title">${escapeHTML(e.title || 'Event')}</div>
              <div class="md-item-meta">${d ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' · ' : ''}${escapeHTML(mode)}</div>
            </div>
          </a>`;
    }).join('')
    : mdEmpty('calendar', 'No upcoming events', 'Propose a talk or meetup for the community.', 'events.html', 'Propose an event');

  // ---------- Contributions ----------
  const contribs = [
    ...proposals.map((p) => ({ title: p.title, status: p.status, kind: 'Event', when: p.created_at || p.event_date })),
    ...posts.map((p) => ({ title: p.title, status: p.approval_status, kind: 'Opportunity', when: p.created_at }))
  ].sort((a, b) => (mdDate(b.when) || 0) - (mdDate(a.when) || 0)).slice(0, 5);
  const statusLabel = { approved: 'Live', pending: 'In review', rejected: 'Not approved' };
  document.getElementById('md-contrib').innerHTML = contribs.length
    ? contribs.map((c) => `
        <div class="md-item md-item-tight">
          <div class="md-item-body">
            <div class="md-item-title">${escapeHTML(c.title || 'Untitled')}</div>
            <div class="md-item-meta">${c.kind}</div>
          </div>
          <span class="md-pill ${c.status || 'pending'}">${statusLabel[c.status] || 'In review'}</span>
        </div>`).join('')
    : mdEmpty('spark', 'Nothing shared yet', 'Share an event or job opportunity with current staff.', 'opportunities.html', 'Post an opportunity');
}

/* ===================== Mentee dashboard ===================== */
const ME_RECS_PATH = '/recommendations'; 

MD_ICONS.briefcase = '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>';
MD_ICONS.search = '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>';

async function mdGet(path) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('alumnet_token')}` }
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function mdFilled(v) {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

function mdProfileHTML(profile) {
  return profileStrengthHTML(profile, { showCta: true });
}

function mdEventsHTML(events, registered) {
  const byDate = (a, b) => (mdDate(a.event_date || a.date) || 0) - (mdDate(b.event_date || b.date) || 0);
  const list = (registered.length ? registered : events).slice().sort(byDate).slice(0, 3);
  if (!list.length) return mdEmpty('calendar', 'No upcoming events', 'New alumni events will appear here.', 'events.html', 'Browse events');
  return (!registered.length ? '<div class="md-hint">Happening soon</div>' : '') + list.map((e) => {
    const d = mdDate(e.event_date || e.date);
    const where = e.mode === 'virtual' ? 'Virtual' : (e.location || 'In person');
    return `
      <a class="md-event" href="events.html">
        <div class="md-date-block">
          <span class="m">${d ? d.toLocaleDateString('en-GB', { month: 'short' }) : '--'}</span>
          <span class="d">${d ? d.getDate() : '--'}</span>
        </div>
        <div class="md-item-body">
          <div class="md-item-title">${escapeHTML(e.title || 'Event')}</div>
          <div class="md-item-meta">${d ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' · ' : ''}${escapeHTML(where)}</div>
        </div>
      </a>`;
  }).join('');
}

async function renderMenteeDashboard() {
  const root = document.getElementById('mentee-dashboard');
  if (!root) return;

  const role = localStorage.getItem('alumnet_role');
  if (role && role !== 'mentee') {
    window.location.href = (typeof HOME_PAGE !== 'undefined' && HOME_PAGE[role]) || 'login.html';
    return;
  }

  const [profileRaw, reqRaw, recRaw, eventsRaw, oppRaw] = await Promise.all([
    mdGet('/profile/me'),
    mdGet('/mentorship-requests'),
    mdGet(ME_RECS_PATH),
    mdGet('/events'),
    mdGet('/opportunities')
  ]);

  const profile = (profileRaw && (profileRaw.profile || profileRaw)) || {};
  const requests = mdList(reqRaw);
  const recs = mdList(recRaw);
  const events = mdList(eventsRaw);
  const opps = mdList(oppRaw);

  const mentorName = (r) => r.other_name || r.mentor_name || r.name || 'Your mentor';
  const mentorDept = (r) => r.other_department || r.mentor_department || r.department || '';
  const active = requests.filter((r) => r.status === 'accepted');
  const pending = requests.filter((r) => r.status === 'pending');
  const registered = events.filter((e) => e.is_registered || e.registered || e.user_registered);
  const profileReady = missingMatchingFields(profile).length === 0;

  // ---------- Header ----------
  const hour = new Date().getHours();
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const first = (profile.name || localStorage.getItem('alumnet_name') || '').split(' ')[0];
  document.getElementById('me-date').textContent = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
  document.getElementById('me-greeting').textContent = first ? `${part}, ${first}` : part;
  document.getElementById('me-sub').textContent =
    active.length ? `You are being mentored by ${mentorName(active[0])}.`
    : pending.length ? `You have ${pending.length} request${pending.length === 1 ? '' : 's'} waiting for a mentor to respond.`
    : 'Start by finding a mentor who matches your career goals.';

  // ---------- Nudge ----------
  if (!profileReady) {
    document.getElementById('me-nudge').innerHTML = `
      <div class="md-banner">
        <div class="md-banner-icon">${mdIcon(MD_ICONS.spark)}</div>
        <div class="md-banner-body">
          <strong>Get better mentor matches</strong>
          <p>Matches are based on your skills, experience and career interests. Add all three for the best recommendations.</p>
        </div>
        <a href="profile.html#edit" class="btn btn-primary">Complete profile</a>
      </div>`;
  }

  // ---------- Stat cards ----------
  const kpi = (icon, num, label, sub, cls = '') => `
    <div class="md-kpi ${cls}">
      <div class="md-kpi-icon">${mdIcon(MD_ICONS[icon])}</div>
      <div class="md-kpi-num">${num}</div>
      <div class="md-kpi-label">${label}</div>
      ${sub ? `<div class="md-kpi-sub">${sub}</div>` : ''}
    </div>`;
  document.getElementById('me-kpis').innerHTML =
    kpi('users', active.length, `Active mentor${active.length === 1 ? '' : 's'}`, active.length ? '' : 'Not matched yet') +
    kpi('inbox', pending.length, 'Requests awaiting reply', '') +
    kpi('calendar', registered.length, 'Events you are attending', '') +
    kpi('briefcase', opps.length, 'Open opportunities', '');

  // ---------- Mentorship ----------
  const mentorshipItems = [
    ...active.map((r) => {
      const since = mdDate(r.responded_at || r.updated_at || r.created_at);
      return `
        <div class="md-item">
          <div class="md-avatar">${mdInitials(mentorName(r))}</div>
          <div class="md-item-body">
            <div class="md-item-title">${escapeHTML(mentorName(r))}${mentorDept(r) ? `<span class="md-muted"> · ${escapeHTML(mentorDept(r))}</span>` : ''}</div>
            <div class="md-item-meta">${since ? `Mentoring you since ${since.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : 'Your mentor'}</div>
          </div>
          <span class="md-pill approved">Active</span>
        </div>`;
    }),
    ...pending.map((r) => {
      const when = r.created_at || r.requested_at;
      return `
        <div class="md-item">
          <div class="md-avatar md-avatar-soft">${mdInitials(mentorName(r))}</div>
          <div class="md-item-body">
            <div class="md-item-title">${escapeHTML(mentorName(r))}${mentorDept(r) ? `<span class="md-muted"> · ${escapeHTML(mentorDept(r))}</span>` : ''}</div>
            <div class="md-item-meta">${when ? `Requested ${timeAgo(when)}` : 'Request sent'}</div>
          </div>
          <span class="md-pill pending">Awaiting reply</span>
        </div>`;
    })
  ].slice(0, 4);
  document.getElementById('me-mentorship').innerHTML = mentorshipItems.length
    ? mentorshipItems.join('')
    : mdEmpty('users', 'No mentor yet', 'Send a request to one of your recommended mentors to get started.', 'recommendations.html', 'Find a mentor');

  // ---------- Top matches ----------
  const top = recs.slice(0, 3);
  document.getElementById('me-matches').innerHTML = top.length
    ? top.map((m) => `
        <div class="md-item">
          <div class="md-avatar md-avatar-soft">${mdInitials(m.name)}</div>
          <div class="md-item-body">
            <div class="md-item-title">${escapeHTML(m.name || 'Mentor')}</div>
            <div class="md-item-meta">${escapeHTML(m.department || '')}${m.years_of_experience ? ` · ${m.years_of_experience} yrs experience` : ''}</div>
          </div>
          ${m.score !== undefined ? `<span class="md-pill match">${m.score}% match</span>` : ''}
          <a href="recommendations.html" class="btn btn-secondary md-btn-sm">View</a>
        </div>`).join('')
    : profileReady
      ? mdEmpty('search', 'See who matches you', 'Your recommended mentors are ranked by how well they fit your goals.', 'recommendations.html', 'View recommendations')
      : mdEmpty('search', 'Complete your profile to see matches', 'Add your skills, experience and career interests so we can recommend mentors.', 'profile.html#edit', 'Complete profile');

  // ---------- Right column ----------
  document.getElementById('me-profile').innerHTML = mdProfileHTML(profile);
  document.getElementById('me-events').innerHTML = mdEventsHTML(events, registered);

  const latest = opps.slice().sort((a, b) => (mdDate(b.created_at) || 0) - (mdDate(a.created_at) || 0)).slice(0, 3);
  document.getElementById('me-opps').innerHTML = latest.length
    ? latest.map((o) => {
        const type = o.opportunity_type ? o.opportunity_type.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '';
        const closes = o.closing_date && typeof closingLabel === 'function' ? closingLabel(o.closing_date) : '';
        return `
          <a class="md-event" href="opportunities.html">
            <div class="md-kpi-icon" style="width:40px;height:40px;">${mdIcon(MD_ICONS.briefcase)}</div>
            <div class="md-item-body">
              <div class="md-item-title">${escapeHTML(o.title || 'Opportunity')}</div>
              <div class="md-item-meta">${escapeHTML([o.company, type].filter(Boolean).join(' · '))}${closes ? ` · ${escapeHTML(closes)}` : ''}</div>
            </div>
          </a>`;
      }).join('')
    : mdEmpty('briefcase', 'No open opportunities', 'Roles shared by retired staff will appear here.');
}

/* ===================== Admin overview ===================== */
MD_ICONS.shield = '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>';
MD_ICONS.activity = '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>';

function mdHumanise(action) {
  return String(action || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

async function renderAdminOverview() {
  const root = document.getElementById('admin-tab-overview');
  if (!root) return;

  const [statsRaw, usersRaw, eventsRaw, oppsRaw, logsRaw, signupsRaw] = await Promise.all([
    mdGet('/admin/stats'),
    mdGet('/admin/users'),
    mdGet('/admin/events/pending'),
    mdGet('/admin/opportunities/pending'),
    mdGet('/admin/activity-logs'),
    mdGet('/admin/signup-requests')
  ]);

  const stats = statsRaw || {};
  const users = mdList(usersRaw);
  const pendingEvents = mdList(eventsRaw);
  const pendingOpps = mdList(oppsRaw);
  const logs = mdList(logsRaw);
  const signups = mdList(signupsRaw);
  const toReview = pendingEvents.length + pendingOpps.length + signups.length;

  // ---------- Header ----------
  document.getElementById('ov-date').textContent = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
  document.getElementById('ov-sub').textContent = toReview
    ? `${toReview} item${toReview === 1 ? '' : 's'} need${toReview === 1 ? 's' : ''} your review.`
    : 'Nothing needs your review right now.';

  // ---------- Stat cards ----------
  const kpi = (icon, num, label, sub, cls = '') => `
    <div class="md-kpi ${cls}">
      <div class="md-kpi-icon">${mdIcon(MD_ICONS[icon])}</div>
      <div class="md-kpi-num">${num ?? 0}</div>
      <div class="md-kpi-label">${label}</div>
      ${sub ? `<div class="md-kpi-sub">${sub}</div>` : ''}
    </div>`;
  const flagged = stats.flaggedAccounts || 0;
  document.getElementById('ov-kpis').innerHTML =
    kpi('users', stats.totalAlumni ?? users.length, 'Total alumni', '') +
    kpi('award', stats.activeMentorships, 'Active mentorships', `${stats.pendingRequests || 0} requests pending`) +
    kpi('inbox', toReview, 'Awaiting review', toReview ? 'Action needed' : 'All clear', toReview ? 'alert' : '') +
    kpi('shield', flagged, 'Flagged accounts', '', flagged ? 'alert' : '');

  // ---------- Needs review ----------
  const reviewRows = [
    ...signups.map((r) => ({
      kind: 'signup', id: r.request_id, title: r.full_name, label: 'Identity check',
      meta: `${r.staff_number} · ${{ low: 'low risk', medium: 'check first', high: 'high risk' }[r.risk_level] || ''}`
    })),
    ...pendingEvents.map((e) => ({
      kind: 'event', id: e.event_id, title: e.title, label: 'Event',
      meta: `Proposed by ${e.proposed_by_name || 'a mentor'}${e.event_date ? ' · ' + new Date(e.event_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''}`
    })),
    ...pendingOpps.map((o) => ({
      kind: 'opportunity', id: o.opportunity_id, title: o.title, label: 'Opportunity',
      meta: `Posted by ${o.posted_by_name || 'a mentor'}${o.company ? ' · ' + o.company : ''}`
    }))
  ];
  document.getElementById('ov-review').innerHTML = reviewRows.length
    ? reviewRows.slice(0, 6).map((r) => `
        <div class="md-item">
          <div class="md-avatar md-avatar-soft">${mdIcon(MD_ICONS[{ event: 'calendar', signup: 'shield' }[r.kind] || 'briefcase'])}</div>
          <div class="md-item-body">
            <div class="md-item-title">${escapeHTML(r.title || 'Untitled')}</div>
            <div class="md-item-meta">${r.label} · ${escapeHTML(r.meta)}</div>
          </div>
          <div class="md-inline-actions">
            ${r.kind === 'signup'
              ? '<a href="#verification" class="btn btn-secondary md-btn-sm" data-goto-tab="verification">Review</a>'
              : `<button class="btn btn-primary md-btn-sm" data-ov-review="${r.id}" data-kind="${r.kind}" data-decision="approved">Approve</button>
            <button class="btn btn-secondary md-btn-sm" data-ov-review="${r.id}" data-kind="${r.kind}" data-decision="rejected">Reject</button>`}
          </div>
        </div>`).join('')
    : mdEmpty('check', 'All clear', 'Identity checks, event proposals and opportunity posts appear here for approval.');

  document.querySelectorAll('[data-ov-review]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.closest('.md-item').querySelectorAll('button').forEach((b) => (b.disabled = true));
      const path = btn.dataset.kind === 'event'
        ? `/admin/events/${btn.dataset.ovReview}/review`
        : `/admin/opportunities/${btn.dataset.ovReview}/review`;
      try {
        await fetch(`${API_BASE}${path}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('alumnet_token')}` },
          body: JSON.stringify({ decision: btn.dataset.decision })
        });
      } catch { /* the refresh below shows the real state */ }
      renderAdminOverview();
      renderAdminPendingEvents();
      renderAdminEvents();
      renderAdminOpportunities();
      renderAdminLogs();
    });
  });

  // ---------- Recent activity ----------
  document.getElementById('ov-activity').innerHTML = logs.length
    ? logs.slice(0, 6).map((l) => `
        <div class="md-item md-item-tight">
          <div class="md-empty-icon" style="width:32px;height:32px;">${mdIcon(MD_ICONS.activity)}</div>
          <div class="md-item-body">
            <div class="md-item-title">${escapeHTML(l.description || mdHumanise(l.action_type))}</div>
            <div class="md-item-meta">${escapeHTML(l.admin_name || 'Admin')} · ${l.created_at ? timeAgo(l.created_at) : ''}</div>
          </div>
        </div>`).join('')
    : mdEmpty('activity', 'No activity yet', 'Admin actions such as approvals and suspensions are recorded here.');

  // ---------- Community ----------
  const mentors = users.filter((u) => u.role === 'mentor').length;
  const mentees = users.filter((u) => u.role === 'mentee').length;
  const total = mentors + mentees || 1;
  const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const newThisMonth = users.filter((u) => u.role !== 'admin' && new Date(u.created_at) >= monthAgo).length;
  document.getElementById('ov-community').innerHTML = `
    <div class="md-progress-row">
      <span class="md-progress-num">${mentors + mentees}</span>
      <span class="md-muted">members · ${newThisMonth} joined in the last 30 days</span>
    </div>
    <div class="md-split">
      <span class="a" style="width:${(mentors / total) * 100}%"></span>
      <span class="b" style="width:${(mentees / total) * 100}%"></span>
    </div>
    <div class="md-legend">
      <div><i class="a"></i>Mentors (retired staff)<b>${mentors}</b></div>
      <div><i class="b"></i>Mentees (current staff)<b>${mentees}</b></div>
    </div>`;

  // ---------- Newest members ----------
  const newest = users.filter((u) => u.role !== 'admin')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 5);
  document.getElementById('ov-members').innerHTML = newest.length
    ? newest.map((u) => `
        <div class="md-item md-item-tight">
          <div class="md-avatar md-avatar-soft">${mdInitials(u.name)}</div>
          <div class="md-item-body">
            <div class="md-item-title">${escapeHTML(u.name)}</div>
            <div class="md-item-meta">Joined ${timeAgo(u.created_at)}</div>
          </div>
          <span class="md-pill ${u.role === 'mentor' ? 'approved' : 'neutral'}">${u.role === 'mentor' ? 'Mentor' : 'Mentee'}</span>
        </div>`).join('')
    : mdEmpty('users', 'No members yet', 'New sign-ups appear here.');
}
/* ===================== Account settings ===================== */

function authHeaders(json = true) {
  const headers = { Authorization: `Bearer ${localStorage.getItem('alumnet_token')}` };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

async function apiSend(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, data };
}

function setMsg(el, text, good) {
  if (!el) return;
  el.textContent = text;
  el.style.color = good ? 'var(--kq-green)' : 'var(--kq-red)';
  el.style.display = text ? 'block' : 'none';
}

function formatDate(value) {
  const d = mdDate(value);
  return d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
}

async function renderAccountSettings() {
  const root = document.getElementById('settings-page');
  if (!root) return;

  let account;
  try {
    const res = await fetch(`${API_BASE}/auth/account`, { headers: authHeaders(false) });
    account = await res.json();
    if (!res.ok) throw new Error(account.error);
  } catch {
    root.querySelector('.md-sub').textContent = 'Could not load your account. Refresh the page to try again.';
    return;
  }

  document.getElementById('st-name').textContent = account.name;
  document.getElementById('st-email').textContent = account.email;
  document.getElementById('st-created').textContent = formatDate(account.createdAt);
  document.getElementById('st-role').textContent = { mentee: 'Mentee (current staff)', mentor: 'Mentor (former staff)', admin: 'Administrator' }[account.role] || account.role;
  document.getElementById('st-verified').textContent = account.verified
    ? `Verified against HR records (${account.employmentStatus === 'former' ? 'former' : 'current'} staff)`
    : (account.role === 'admin' ? 'Alumni office account' : 'Not linked to an HR record');
  if (account.role === 'admin' && !account.twoFactorEnabled) document.getElementById('st-admin-2fa').style.display = 'block';
  document.getElementById('st-pw-changed').textContent = account.passwordChangedAt ? `Last changed ${timeAgo(account.passwordChangedAt)}` : '';

  // ---------- Password ----------
  const pwForm = document.getElementById('password-form');
  pwForm.onsubmit = async (e) => {
    e.preventDefault();
    const msg = document.getElementById('password-msg');
    const currentPassword = document.getElementById('current-password').value;
    const newPassword = document.getElementById('new-password').value;
    if (!currentPassword) { setMsg(msg, 'Enter your current password.'); return; }
    const problem = passwordProblem(newPassword);
    if (problem) { setMsg(msg, problem); return; }
    if (newPassword !== document.getElementById('confirm-password').value) { setMsg(msg, 'New passwords do not match.'); return; }
    const btn = pwForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    const { ok, data } = await apiSend('POST', '/auth/change-password', { currentPassword, newPassword });
    btn.disabled = false;
    setMsg(msg, ok ? 'Password updated.' : data.error, ok);
    if (ok) {
      pwForm.reset();
      document.getElementById('st-pw-changed').textContent = 'Last changed just now';
    }
  };

  // ---------- Sessions ----------
  document.getElementById('logout-everywhere').onclick = async () => {
    if (!confirm('Log out of AlumNet on every device, including this one?')) return;
    const { ok, data } = await apiSend('POST', '/auth/logout-everywhere');
    if (!ok) { setMsg(document.getElementById('sessions-msg'), data.error); return; }
    clearSession();
    window.location.href = 'login.html';
  };

  // ---------- Data rights ----------
  document.getElementById('export-data').onclick = async () => {
    const btn = document.getElementById('export-data');
    btn.disabled = true;
    try {
      const res = await fetch(`${API_BASE}/auth/account/export`);
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `alumnet-my-data-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch {
      alert('Could not download your data. Try again.');
    } finally {
      btn.disabled = false;
    }
  };

  if (account.role === 'admin') {
    document.getElementById('delete-wrap').style.display = 'none';
  } else {
    if (account.twoFactorEnabled) document.getElementById('del-code-field').style.display = 'block';
    document.getElementById('delete-form').onsubmit = async (e) => {
      e.preventDefault();
      const msg = document.getElementById('del-msg');
      if (!document.getElementById('del-confirm').checked) { setMsg(msg, 'Tick the box to confirm.'); return; }
      const { ok, data } = await apiSend('POST', '/auth/account/delete', {
        password: document.getElementById('del-password').value,
        code: document.getElementById('del-code').value
      });
      if (!ok) { setMsg(msg, data.error); return; }
      clearSession();
      window.location.href = 'login.html';
    };
  }

  drawTwoFactorPanel(account.twoFactorEnabled, account.backupCodesLeft);
  drawGooglePanel(account.googleLinked);
}

// Shown once, straight after they are created. Only hashes are stored.
function backupCodesHTML(codes) {
  return `
    <div class="st-codes-box">
      <p class="st-text"><strong>Save these backup codes now.</strong> Each one works once if you lose your phone. You will not see them again.</p>
      <ul class="st-codes">${codes.map((c) => `<li><code>${escapeHTML(c)}</code></li>`).join('')}</ul>
      <div class="st-actions" style="justify-content:flex-start; gap:10px;">
        <button type="button" class="btn btn-secondary md-btn-sm" id="codes-copy">Copy</button>
        <button type="button" class="btn btn-secondary md-btn-sm" id="codes-download">Download</button>
      </div>
    </div>`;
}

function wireBackupCodeButtons(codes) {
  const text = `AlumNet backup codes (each works once)\n\n${codes.join('\n')}\n`;
  const copy = document.getElementById('codes-copy');
  if (copy) copy.onclick = async () => {
    try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy failed'; }
  };
  const dl = document.getElementById('codes-download');
  if (dl) dl.onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'alumnet-backup-codes.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
}

function setPill(id, on, onText, offText) {
  const pill = document.getElementById(id);
  pill.textContent = on ? onText : offText;
  pill.className = `md-pill ${on ? 'approved' : 'neutral'}`;
}

function drawTwoFactorPanel(enabled, codesLeft = 0, newCodes = null) {
  const panel = document.getElementById('twofa-panel');
  setPill('twofa-pill', enabled, 'On', 'Off');
  const adminBanner = document.getElementById('st-admin-2fa');
  if (adminBanner && enabled) adminBanner.style.display = 'none';

  if (enabled) {
    const low = codesLeft <= 2;
    panel.innerHTML = `
      <p class="st-text">Each time you log in, AlumNet asks for a code from your authenticator app as well as your password.</p>
      ${newCodes ? backupCodesHTML(newCodes) : `
        <p class="st-text" ${low ? 'style="color:var(--kq-red);"' : ''}>Backup codes left: <strong>${codesLeft}</strong>${low ? '. Make new ones so you are not locked out.' : ''}</p>`}
      <details class="st-disclosure">
        <summary>Make new backup codes</summary>
        <form id="codes-form" novalidate>
          <p class="st-text">Your old codes stop working.</p>
          <div class="field"><label for="codes-password">Password</label><input type="password" id="codes-password" autocomplete="current-password"></div>
          <p class="st-msg" id="codes-msg"></p>
          <button type="submit" class="btn btn-secondary md-btn-sm">Make new codes</button>
        </form>
      </details>
      <details class="st-disclosure">
        <summary>Turn off two-factor authentication</summary>
        <form id="twofa-disable-form" novalidate>
          <div class="field"><label for="tf-off-password">Password</label><input type="password" id="tf-off-password" autocomplete="current-password"></div>
          <div class="field"><label for="tf-off-code">Code from your app, or a backup code</label><input type="text" id="tf-off-code" class="code-input" maxlength="11" placeholder="000000"></div>
          <p class="st-msg" id="tf-off-msg"></p>
          <button type="submit" class="btn btn-secondary md-btn-sm">Turn off</button>
        </form>
      </details>`;
    document.getElementById('twofa-disable-form').onsubmit = async (e) => {
      e.preventDefault();
      const { ok, data } = await apiSend('POST', '/auth/2fa/disable', {
        password: document.getElementById('tf-off-password').value,
        code: document.getElementById('tf-off-code').value
      });
      if (ok) drawTwoFactorPanel(false);
      else setMsg(document.getElementById('tf-off-msg'), data.error);
    };
    document.getElementById('codes-form').onsubmit = async (e) => {
      e.preventDefault();
      const { ok, data } = await apiSend('POST', '/auth/2fa/backup-codes', { password: document.getElementById('codes-password').value });
      if (ok) drawTwoFactorPanel(true, data.backupCodes.length, data.backupCodes);
      else setMsg(document.getElementById('codes-msg'), data.error);
    };
    if (newCodes) wireBackupCodeButtons(newCodes);
    return;
  }

  panel.innerHTML = `
    <p class="st-text">Add a second step to your login using a free authenticator app such as Google Authenticator or Microsoft Authenticator. Even if someone learns your password, they cannot sign in without your phone.</p>
    <button class="btn btn-primary md-btn-sm" id="twofa-start">Set up two-factor</button>`;
  document.getElementById('twofa-start').onclick = async () => {
    const { ok, data } = await apiSend('POST', '/auth/2fa/setup');
    if (!ok) { panel.insertAdjacentHTML('beforeend', `<p class="st-msg" style="display:block;color:var(--kq-red);">${escapeHTML(data.error)}</p>`); return; }
    panel.innerHTML = `
      <ol class="st-steps">
        <li>Open your authenticator app and add an account.</li>
        <li>Scan this QR code, or enter the key below.</li>
        <li>Type the 6-digit code the app shows.</li>
      </ol>
      <div class="st-qr"><img src="${data.qr}" alt="QR code for your authenticator app" width="180" height="180"></div>
      <p class="st-key">Key: <code>${escapeHTML(data.secret.replace(/(.{4})/g, '$1 ').trim())}</code></p>
      <form id="twofa-enable-form" novalidate>
        <div class="field"><label for="tf-code">Code from your app</label><input type="text" id="tf-code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"></div>
        <p class="st-msg" id="tf-msg"></p>
        <div class="st-actions">
          <button type="button" class="btn-quiet" id="twofa-cancel">Cancel</button>
          <button type="submit" class="btn btn-primary md-btn-sm">Turn on</button>
        </div>
      </form>`;
    document.getElementById('tf-code').focus();
    document.getElementById('twofa-cancel').onclick = () => drawTwoFactorPanel(false);
    document.getElementById('twofa-enable-form').onsubmit = async (e) => {
      e.preventDefault();
      const result = await apiSend('POST', '/auth/2fa/enable', { code: document.getElementById('tf-code').value });
      if (result.ok) drawTwoFactorPanel(true, result.data.backupCodes.length, result.data.backupCodes);
      else setMsg(document.getElementById('tf-msg'), result.data.error);
    };
  };
}

async function drawGooglePanel(linked) {
  const panel = document.getElementById('google-panel');
  setPill('google-pill', linked, 'Linked', 'Not linked');

  if (linked) {
    panel.innerHTML = `
      <p class="st-text">You can log in with the "Sign in with Google" button. Your password still works too.</p>
      <p class="st-msg" id="google-msg"></p>
      <button class="btn btn-secondary md-btn-sm" id="google-unlink">Unlink Google</button>`;
    document.getElementById('google-unlink').onclick = async () => {
      const { ok, data } = await apiSend('DELETE', '/auth/google/link');
      if (ok) drawGooglePanel(false);
      else setMsg(document.getElementById('google-msg'), data.error);
    };
    return;
  }

  panel.innerHTML = `
    <p class="st-text">Link a Google account so you can sign in with one click. Useful if your AlumNet email is a work address.</p>
    <div id="google-link-btn" class="google-btn-wrap"></div>
    <p class="st-msg" id="google-msg"></p>`;
  const shown = await renderGoogleButton(document.getElementById('google-link-btn'), async (credential) => {
    const { ok, data } = await apiSend('POST', '/auth/google/link', { credential });
    if (ok) drawGooglePanel(true);
    else setMsg(document.getElementById('google-msg'), data.error);
  }, 'continue_with');
  if (!shown) {
    setMsg(document.getElementById('google-msg'), 'Google sign-in is not set up on this server yet.');
    document.getElementById('google-msg').style.color = 'var(--slate)';
  }
}

/* --------------------------------------------------------------------
   First-time setup wizard. Suggestions come from the person's HR
   department so they do not start from a blank page. Skipping still
   marks the account as set up, so the wizard never nags.
   -------------------------------------------------------------------- */

const DEPARTMENT_SKILLS = {
  'Flight Operations': ['Crew resource management', 'Flight planning', 'Aviation safety', 'Fleet scheduling', 'Regulatory compliance', 'Pilot training'],
  'Cabin Services': ['Passenger safety', 'Customer service', 'Crew leadership', 'First aid', 'Service training', 'Conflict resolution'],
  'Engineering & Maintenance': ['Aircraft maintenance', 'Quality assurance', 'Technical documentation', 'Reliability analysis', 'Regulatory compliance', 'Root cause analysis'],
  'Ground Operations': ['Ramp operations', 'Turnaround planning', 'Ground safety', 'Team supervision', 'Baggage systems', 'On-time performance'],
  'Cargo & Logistics': ['Cargo handling', 'Dangerous goods', 'Supply chain', 'Customs procedures', 'Revenue management', 'Warehouse operations'],
  'Customer Experience': ['Customer service', 'Complaint handling', 'Service design', 'Loyalty programmes', 'Data analysis', 'Stakeholder management'],
  'Commercial & Sales': ['Sales strategy', 'Revenue management', 'Pricing', 'Partnerships', 'Market analysis', 'Negotiation'],
  'IT & Digital': ['Software development', 'Data analysis', 'Cybersecurity', 'Systems administration', 'Project management', 'Cloud platforms'],
  'Human Resources': ['Recruitment', 'Employee relations', 'Training and development', 'Performance management', 'Labour law', 'Payroll'],
  Finance: ['Financial reporting', 'Budgeting', 'Audit', 'Treasury', 'Cost control', 'Financial analysis'],
  Security: ['Aviation security', 'Risk assessment', 'Incident response', 'Screening procedures', 'Regulatory compliance', 'Investigations'],
  Corporate: ['Strategy', 'Corporate communications', 'Governance', 'Project management', 'Stakeholder management', 'Public relations']
};
const MENTEE_GOALS = ['Leadership', 'Moving into management', 'Changing department', 'Technical certification', 'Further studies', 'Public speaking', 'Career planning', 'Work-life balance'];
const MENTOR_HELP = ['Leadership', 'Career planning', 'Technical guidance', 'Interview preparation', 'Moving into management', 'Industry knowledge', 'Retirement planning', 'Starting a business'];

function chipPicker(container, options, textarea) {
  const current = () => splitList(textarea.value).map((x) => x.toLowerCase());
  container.innerHTML = options.map((o) => `<button type="button" class="ob-chip" data-chip="${escapeHTML(o)}">${escapeHTML(o)}</button>`).join('');
  const sync = () => container.querySelectorAll('.ob-chip').forEach((c) => c.classList.toggle('on', current().includes(c.dataset.chip.toLowerCase())));
  container.querySelectorAll('.ob-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const items = splitList(textarea.value);
      const i = items.findIndex((x) => x.toLowerCase() === chip.dataset.chip.toLowerCase());
      if (i >= 0) items.splice(i, 1); else items.push(chip.dataset.chip);
      textarea.value = items.join(', ');
      sync();
    });
  });
  textarea.addEventListener('input', sync);
  sync();
}

async function wireOnboarding() {
  const root = document.getElementById('onboarding-page');
  if (!root) return;
  const p = await mdGet('/profile/me');
  if (!p) { document.getElementById('ob-sub').textContent = 'Could not load your profile. Refresh to try again.'; return; }
  const home = HOME_PAGE[p.role] || 'login.html';
  if (p.onboarded_at) { window.location.href = home; return; }

  const mentor = p.role === 'mentor';
  document.getElementById('ob-title').textContent = `Welcome, ${(p.name || '').split(' ')[0]}`;
  document.getElementById('ob-sub').textContent = mentor
    ? 'You have joined as a mentor. A few details help current staff find you. It takes about two minutes.'
    : 'You have joined as a mentee. A few details help us match you with the right mentor. It takes about two minutes.';
  document.getElementById('ob-headline').placeholder = mentor ? 'e.g. Retired Captain, 25 years with Kenya Airways' : 'e.g. Cabin Crew | Aspiring Safety Trainer';
  document.getElementById('ob-exp-hint').textContent = mentor
    ? 'The roles you held at Kenya Airways and what you are proud of.'
    : 'Your current role and what you do day to day.';
  document.getElementById('ob-years-field').style.display = mentor ? 'block' : 'none';
  if (mentor) {
    document.getElementById('ob-goals-title').textContent = 'What you can help with';
    document.getElementById('ob-goals-hint').textContent = 'Areas where you would like to guide current staff.';
    document.getElementById('ob-goals-label').textContent = 'Areas you can help with';
  }

  const f = {
    headline: document.getElementById('ob-headline'), city: document.getElementById('ob-city'),
    country: document.getElementById('ob-country'), skills: document.getElementById('ob-skills'),
    experience: document.getElementById('ob-experience'), years: document.getElementById('ob-years'),
    goals: document.getElementById('ob-goals')
  };
  f.headline.value = p.headline || '';
  f.city.value = p.city || '';
  f.country.value = p.country || 'Kenya';
  f.skills.value = p.skills || '';
  f.experience.value = p.experience || '';
  f.years.value = p.years_of_experience ?? '';
  f.goals.value = p.career_interests || '';
  chipPicker(document.getElementById('ob-skill-chips'), DEPARTMENT_SKILLS[p.department] || DEPARTMENT_SKILLS.Corporate, f.skills);
  chipPicker(document.getElementById('ob-goal-chips'), mentor ? MENTOR_HELP : MENTEE_GOALS, f.goals);

  let step = 1;
  const total = 4;
  const msg = document.getElementById('ob-msg');
  const next = document.getElementById('ob-next');
  const back = document.getElementById('ob-back');
  function show() {
    root.querySelectorAll('.ob-step').forEach((el) => { el.style.display = Number(el.dataset.step) === step ? 'block' : 'none'; });
    document.querySelectorAll('#ob-progress span').forEach((s, i) => s.classList.toggle('on', i < step));
    back.style.display = step > 1 ? 'inline-flex' : 'none';
    next.textContent = step === total ? 'Finish' : 'Next';
    setMsg(msg, '');
  }

  async function save(finish) {
    const body = {
      headline: f.headline.value, city: f.city.value, country: f.country.value,
      skills: f.skills.value, experience: f.experience.value, careerInterests: f.goals.value
    };
    if (mentor) body.yearsOfExperience = f.years.value;
    if (finish) body.completeOnboarding = true;
    return apiSend('PUT', '/profile/me', body);
  }

  next.addEventListener('click', async () => {
    if (step === 2 && !splitList(f.skills.value).length) { setMsg(msg, 'Add at least one skill. Matching depends on it.'); return; }
    if (step < total) { step++; show(); return; }
    next.disabled = true;
    const { ok, data } = await save(true);
    next.disabled = false;
    if (!ok) { setMsg(msg, data.error || 'Could not save. Try again.'); return; }
    window.location.href = home;
  });
  back.addEventListener('click', () => { step--; show(); });
  document.getElementById('ob-skip').addEventListener('click', async () => {
    await apiSend('PUT', '/profile/me', { completeOnboarding: true });
    window.location.href = home;
  });
  show();
}
