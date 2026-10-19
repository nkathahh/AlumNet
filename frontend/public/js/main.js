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
});

const API_BASE = 'http://localhost:4000/api';

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
  'admin.html': ['admin']
};

const NAV_CONFIG = {
  mentee: [
    {
      group: 'Network', links: [
        { href: 'mentee-dashboard.html', label: 'Dashboard' },
        { href: 'recommendations.html', label: 'Find a mentor' },
        { href: 'requests.html', label: 'My requests' },
        { href: 'profile.html', label: 'My profile' }
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
        { href: 'profile.html', label: 'My profile' }
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
        { tab: 'users', label: 'User management' },
        { tab: 'events', label: 'Event management' },
        { tab: 'opportunities', label: 'Content moderation' },
        { tab: 'logs', label: 'Activity log' }
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
    nav.innerHTML = groups.map((g) => `
      <div class="nav-group">
        <div class="nav-group-label">${g.group}</div>
        ${g.links.map((l, i) => `<a class="nav-link ${i === 0 ? 'active' : ''}" href="#" data-admin-tab="${l.tab}">${l.label}</a>`).join('')}
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
  btn.addEventListener('click', () => {
    localStorage.removeItem('alumnet_token');
    localStorage.removeItem('alumnet_role');
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
  const form = document.getElementById('signup-form');
  if (!form) return;

  const roleSelect = document.getElementById('role');
  const staffFields = document.getElementById('staff-fields');
  const menteeEmailField = document.getElementById('mentee-email-field');
  const mentorEmailField = document.getElementById('mentor-email-field');
  const staffNumberInput = document.getElementById('staffNumber');
  const staffStatus = document.getElementById('staff-lookup-status');
  const errorEl = document.getElementById('signup-error');
  const passwordInput = document.getElementById('password');
  const confirmInput = document.getElementById('confirmPassword');
  const matchStatus = document.getElementById('password-match-status');
  const toggleBtn = document.getElementById('toggle-password');
  let verifiedStaff = null;

  toggleBtn.addEventListener('click', () => {
    const show = passwordInput.type === 'password';
    passwordInput.type = show ? 'text' : 'password';
    toggleBtn.textContent = show ? 'Hide' : 'Show';
  });

  function checkPasswordsMatch() {
    if (!confirmInput.value) { matchStatus.textContent = ''; return; }
    const match = passwordInput.value === confirmInput.value;
    matchStatus.textContent = match ? 'Passwords match.' : 'Passwords do not match.';
    matchStatus.style.color = match ? 'var(--kq-green)' : 'var(--kq-red)';
  }
  passwordInput.addEventListener('input', checkPasswordsMatch);
  confirmInput.addEventListener('input', checkPasswordsMatch);

  roleSelect.addEventListener('change', () => {
    const role = roleSelect.value;
    staffFields.style.display = role ? 'block' : 'none';
    menteeEmailField.style.display = role === 'mentee' ? 'block' : 'none';
    mentorEmailField.style.display = role === 'mentor' ? 'block' : 'none';
  });

  staffNumberInput.addEventListener('blur', async () => {
    verifiedStaff = null;
    document.getElementById('fullName').value = '';
    document.getElementById('department').value = '';
    document.getElementById('idNumberDisplay').value = '';
    document.getElementById('emailMentee').value = '';
    if (!staffNumberInput.value) { staffStatus.textContent = ''; return; }

    staffStatus.textContent = 'Checking...';
    try {
      const res = await fetch(`${API_BASE}/auth/staff-lookup?staffNumber=${encodeURIComponent(staffNumberInput.value)}`);
      const data = await res.json();
      if (!res.ok) { staffStatus.textContent = data.error || 'Staff number not found'; return; }

      verifiedStaff = data;
      document.getElementById('fullName').value = data.full_name;
      document.getElementById('department').value = data.department;
      document.getElementById('idNumberDisplay').value = data.id_number;
      if (data.mobile_number) document.getElementById('mobileNumber').value = data.mobile_number;
      if (roleSelect.value === 'mentee') document.getElementById('emailMentee').value = data.kq_email || '';
      staffStatus.textContent = `Verified: ${data.full_name} (${data.department}, ${data.employment_status})`;
    } catch {
      staffStatus.textContent = 'Could not reach the server.';
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.style.display = 'none';
    const role = roleSelect.value;

    if (!verifiedStaff) {
      errorEl.textContent = 'Enter your staff number and wait for it to verify.';
      errorEl.style.display = 'block'; return;
    }
    if (role === 'mentee' && verifiedStaff.employment_status !== 'active') {
      errorEl.textContent = 'Only current employees can register as mentees.';
      errorEl.style.display = 'block'; return;
    }
    if (passwordInput.value !== confirmInput.value) {
      errorEl.textContent = 'Passwords do not match.';
      errorEl.style.display = 'block'; return;
    }

    const payload = {
      role, staffNumber: staffNumberInput.value, password: passwordInput.value,
      mobileNumber: document.getElementById('mobileNumber').value || undefined,
      country: document.getElementById('country').value,
      city: document.getElementById('city').value,
      skills: document.getElementById('skills').value,
      experience: document.getElementById('experience').value,
      careerInterests: document.getElementById('interests').value,
      industry: document.getElementById('industry').value,
      email: role === 'mentor' ? document.getElementById('emailMentor').value : undefined,
      yearsOfExperience: role === 'mentor' ? document.getElementById('mentorYears').value || null : undefined
    };

    try {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const result = await res.json();
      if (!res.ok) { errorEl.textContent = result.error || 'Registration failed'; errorEl.style.display = 'block'; return; }
      localStorage.setItem('alumnet_token', result.token);
      localStorage.setItem('alumnet_role', result.role);
      window.location.href = HOME_PAGE[result.role] || 'login.html';
    } catch {
      errorEl.textContent = 'Could not reach the server. Is the backend running on port 4000?';
      errorEl.style.display = 'block';
    }
  });
}

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

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing you in...';

    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const result = await res.json();

      if (!res.ok) {
        errorEl.textContent = result.error || 'Login failed';
        errorEl.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Log in';
        return;
      }

      localStorage.setItem('alumnet_token', result.token);
      localStorage.setItem('alumnet_role', result.role);
      submitBtn.textContent = 'Taking off... ✈';
      navigateWithFade(HOME_PAGE[result.role] || 'login.html');
    } catch {
      errorEl.textContent = 'Could not reach the server. Is the backend running on port 4000?';
      errorEl.style.display = 'block';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Log in';
    }
  });
}

/* --------------------------------------------------------------------
   Mentor recommendations (FR-04) — real, calls the ML service
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
      list.innerHTML = `<p style="color:var(--kq-red); padding:20px 4px;">${data.error || 'Could not load recommendations.'}</p>`;
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
   Mentorship requests (FR-05, FR-06) — real
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
        <strong>${r.other_name}</strong><br>
        <span style="font-size:0.82rem; color:var(--slate);">${r.other_department || ''} · ${r.status === 'ended' ? 'Ended' : 'Requested'} on ${date}</span>
      </div>
      ${actionHTML}
    </div>`;
}

/* --------------------------------------------------------------------
   Profile (FR-03) — real
   -------------------------------------------------------------------- */

async function wireProfileForm() {
  const form = document.getElementById('profile-form');
  if (!form) return;
  const token = localStorage.getItem('alumnet_token');
  if (!token) { window.location.href = 'login.html'; return; }

  try {
    const res = await fetch(`${API_BASE}/profile/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const data = await res.json();
      form.skills.value = data.skills || '';
      form.experience.value = data.experience || '';
      form.interests.value = data.career_interests || '';
      if (data.industry) form.industry.value = data.industry;
      renderProfileHeader(data);
    }
  } catch (err) {
    console.error('Could not load profile', err);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const statusEl = document.getElementById('save-status');
    try {
      const res = await fetch(`${API_BASE}/profile/me`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          skills: data.skills,
          experience: data.experience,
          careerInterests: data.interests,
          industry: data.industry
        })
      });
      if (!res.ok) throw new Error('Save failed');
      statusEl.textContent = 'Saved ✓';
      statusEl.classList.add('visible');
      setTimeout(() => statusEl.classList.remove('visible'), 2000);
    } catch (err) {
      console.error(err);
      statusEl.textContent = 'Could not save';
      statusEl.style.color = 'var(--kq-red)';
      statusEl.classList.add('visible');
    }
  });
}

function renderProfileHeader(data) {
  const nameEl = document.getElementById('profile-name');
  const avatarEl = document.getElementById('profile-avatar');
  const badgeEl = document.getElementById('profile-role-badge');
  const deptEl = document.getElementById('profile-dept');
  const yearsEl = document.getElementById('profile-years');
  if (!nameEl) return;

  nameEl.textContent = data.name;

  const initials = (data.name || '').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  avatarEl.textContent = initials;
  avatarEl.style.background = colorFromName(data.name || '');

  badgeEl.textContent = data.role;
  badgeEl.className = `role-badge ${data.role}`;

  if (data.department) deptEl.textContent = data.department;

  if (data.role === 'mentor' && data.years_of_experience) {
    yearsEl.textContent = `${data.years_of_experience} yrs experience`;
    yearsEl.style.display = 'inline';
  }
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

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal-card">
      <h3>${data.name}</h3>
      <div class="modal-meta">${data.department || ''}${data.years_of_experience ? ' · ' + data.years_of_experience + ' yrs experience' : ''}</div>
      <div class="modal-section"><div class="label">Skills</div><div class="value">${data.skills || 'Not provided'}</div></div>
      <div class="modal-section"><div class="label">Experience</div><div class="value">${data.experience || 'Not provided'}</div></div>
      <div class="modal-section"><div class="label">Career interests</div><div class="value">${data.career_interests || 'Not provided'}</div></div>
      <button class="btn btn-secondary btn-block" id="close-modal">Close</button>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.getElementById('close-modal').addEventListener('click', () => backdrop.remove());
}

/* --------------------------------------------------------------------
   Events (FR-07, FR-08) — mentee/mentor view, still mock
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
      grid.innerHTML = `<p style="color:var(--kq-red); padding:20px 4px;">${data.error || 'Could not load events.'}</p>`;
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
  const host = e.is_official ? 'KQ Alumni Office' : (e.organiser_name || 'Alumni member');

  let where;
  if (e.mode === 'virtual') {
    where = e.location
      ? `Virtual · <a href="${e.location}" target="_blank" rel="noopener">Join link</a>`
      : 'Virtual · link shared after registering';
  } else {
    where = e.location || 'Venue to be confirmed';
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
      <h3>${e.title}</h3>
      <p>${e.description || ''}</p>
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
            <strong>${p.title}</strong><br>
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
    if (!res.ok) { list.innerHTML = `<p>${rows.error || 'Could not load proposals.'}</p>`; return; }
    if (!rows.length) {
      list.innerHTML = '<p style="color:var(--slate); padding:20px 4px;">No event proposals waiting for review.</p>';
      return;
    }

    list.innerHTML = rows.map((e) => `
      <div class="opportunity-card">
        <div>
          <span class="tag">${e.mode === 'virtual' ? 'Virtual' : 'In person'}</span>
          <h3 style="font-size:1rem; margin:6px 0;">${e.title}</h3>
          <p class="mentor-blurb">${e.description || ''}</p>
          <div class="mentor-meta">
            ${new Date(e.event_date).toLocaleString('en-GB')} · ${e.location || ''}${e.capacity ? ' · capacity ' + e.capacity : ''}
          </div>
          <div class="mentor-meta">Proposed by ${e.proposed_by_name}</div>
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
   Career opportunities (FR-09) — mentee/mentor view, still mock
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
  const href = isEmail ? `mailto:${link}` : link;
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
      ${link
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
   Admin dashboard (FR-12) — real, all four tabs
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
      tbody.innerHTML = `<tr><td colspan="6">${stats.error || users.error || 'Could not load admin data.'}</td></tr>`;
      return;
    }

    statRow.innerHTML = `
      <div class="stat-card"><div class="num">${stats.totalAlumni}</div><div class="label">Total alumni</div></div>
      <div class="stat-card"><div class="num">${stats.activeMentorships}</div><div class="label">Active mentorships</div></div>
      <div class="stat-card"><div class="num">${stats.pendingRequests}</div><div class="label">Pending requests</div></div>
      <div class="stat-card"><div class="num">${stats.flaggedAccounts}</div><div class="label">Flagged accounts</div></div>`;

    allAdminUsers = users;
    tbody.innerHTML = users.map(adminRowHTML).join('');
    wireAdminActions(tbody, token);
  } catch {
    tbody.innerHTML = '<tr><td colspan="6">Could not reach the server.</td></tr>';
  }
}

function adminRowHTML(u) {
  const joined = new Date(u.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const isSuspended = u.status === 'suspended';
  return `
    <tr>
      <td>${u.name}</td><td>${u.email}</td><td>${u.role}</td>
      <td>${isSuspended ? 'Flagged' : 'Active'}</td><td>${joined}</td>
      <td><button class="btn btn-secondary" data-action="toggle-status" data-user-id="${u.user_id}">
        ${isSuspended ? 'Reactivate' : 'Suspend'}
      </button></td>
    </tr>`;
}

function wireAdminActions(tbody, token) {
  tbody.querySelectorAll('[data-action="toggle-status"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const userId = btn.dataset.userId;
      btn.disabled = true;
      try {
        const res = await fetch(`${API_BASE}/admin/users/${userId}/toggle-status`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}` }
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
    const q = input.value.toLowerCase();
    const filtered = allAdminUsers.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
    const tbody = document.getElementById('admin-table-body');
    tbody.innerHTML = filtered.map(adminRowHTML).join('');
    wireAdminActions(tbody, localStorage.getItem('alumnet_token'));
  });
}

const ADMIN_TABS = ['overview', 'users', 'events', 'opportunities', 'logs'];

function showAdminTab(name) {
  ADMIN_TABS.forEach((t) => {
    const el = document.getElementById(`admin-tab-${t}`);
    if (el) el.style.display = t === name ? 'block' : 'none';
  });
  document.querySelectorAll('[data-admin-tab]').forEach((l) => {
    l.classList.toggle('active', l.dataset.adminTab === name);
  });
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
  showAdminTab('overview');
}

async function renderAdminEvents() {
  const tbody = document.getElementById('admin-events-body');
  if (!tbody) return;
  const token = localStorage.getItem('alumnet_token');

  const res = await fetch(`${API_BASE}/admin/events`, { headers: { Authorization: `Bearer ${token}` } });
  const events = await res.json();
  if (!res.ok) { tbody.innerHTML = `<tr><td colspan="4">${events.error}</td></tr>`; return; }

  tbody.innerHTML = events.map((e) => `
    <tr>
      <td>${e.title}</td>
      <td>${new Date(e.event_date).toLocaleString('en-GB')}</td>
      <td>${e.description || ''}</td>
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

async function renderAdminLogs() {
  const tbody = document.getElementById('admin-logs-body');
  if (!tbody) return;
  const token = localStorage.getItem('alumnet_token');

  const res = await fetch(`${API_BASE}/admin/activity-logs`, { headers: { Authorization: `Bearer ${token}` } });
  const logs = await res.json();
  if (!res.ok) { tbody.innerHTML = `<tr><td colspan="5">${logs.error}</td></tr>`; return; }

  tbody.innerHTML = logs.map((l) => `
    <tr>
      <td>${new Date(l.created_at).toLocaleString('en-GB')}</td>
      <td>${l.admin_name}</td><td>${l.action_type}</td>
      <td>${l.target_entity} #${l.target_entity_id}</td><td>${l.description || ''}</td>
    </tr>`).join('');
}

/* --------------------------------------------------------------------
   Notifications — still mock
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
  if (!profile.skills || !profile.experience) {
    document.getElementById('md-nudge').innerHTML = `
      <div class="md-banner">
        <div class="md-banner-icon">${mdIcon(MD_ICONS.spark)}</div>
        <div class="md-banner-body">
          <strong>Mentees can't find you yet</strong>
          <p>Recommendations are based on your skills and experience. Add them so the right mentees are matched with you.</p>
        </div>
        <a href="profile.html" class="btn btn-primary">Complete profile</a>
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
  const checks = [
    ['Department', profile.department],
    ['Years of experience', profile.years_of_experience],
    ['Skills', profile.skills],
    ['Experience summary', profile.experience],
    ['Career interests', profile.career_interests]
  ];
  const done = checks.filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '').length;
  const pct = Math.round((done / checks.length) * 100);
  document.getElementById('md-profile').innerHTML = `
    <div class="md-progress-row">
      <span class="md-progress-num">${pct}%</span>
      <span class="md-muted">${pct === 100 ? 'Complete' : `${checks.length - done} item${checks.length - done === 1 ? '' : 's'} left`}</span>
    </div>
    <div class="md-progress"><div style="width:${pct}%"></div></div>
    <ul class="md-checklist">
      ${checks.map(([label, v]) => {
    const ok = v !== null && v !== undefined && String(v).trim() !== '';
    return `<li class="${ok ? 'ok' : ''}">${mdIcon(ok ? MD_ICONS.check : MD_ICONS.dot)}${label}</li>`;
  }).join('')}
    </ul>`;

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
  const checks = [
    ['Department', profile.department],
    ['Years of experience', profile.years_of_experience],
    ['Skills', profile.skills],
    ['Experience summary', profile.experience],
    ['Career interests', profile.career_interests]
  ];
  const done = checks.filter(([, v]) => mdFilled(v)).length;
  const pct = Math.round((done / checks.length) * 100);
  return `
    <div class="md-progress-row">
      <span class="md-progress-num">${pct}%</span>
      <span class="md-muted">${pct === 100 ? 'Complete' : `${checks.length - done} item${checks.length - done === 1 ? '' : 's'} left`}</span>
    </div>
    <div class="md-progress"><div style="width:${pct}%"></div></div>
    <ul class="md-checklist">
      ${checks.map(([label, v]) => `<li class="${mdFilled(v) ? 'ok' : ''}">${mdIcon(mdFilled(v) ? MD_ICONS.check : MD_ICONS.dot)}${label}</li>`).join('')}
    </ul>`;
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
  const profileReady = mdFilled(profile.skills) && mdFilled(profile.career_interests);

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
          <p>Recommendations are based on your skills, experience and career interests. The more you add, the better your matches.</p>
        </div>
        <a href="profile.html" class="btn btn-primary">Complete profile</a>
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
      : mdEmpty('search', 'Complete your profile to see matches', 'Add your skills and career interests so we can recommend mentors.', 'profile.html', 'Complete profile');

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

  const [statsRaw, usersRaw, eventsRaw, oppsRaw, logsRaw] = await Promise.all([
    mdGet('/admin/stats'),
    mdGet('/admin/users'),
    mdGet('/admin/events/pending'),
    mdGet('/admin/opportunities/pending'),
    mdGet('/admin/activity-logs')
  ]);

  const stats = statsRaw || {};
  const users = mdList(usersRaw);
  const pendingEvents = mdList(eventsRaw);
  const pendingOpps = mdList(oppsRaw);
  const logs = mdList(logsRaw);
  const toReview = pendingEvents.length + pendingOpps.length;

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
          <div class="md-avatar md-avatar-soft">${mdIcon(MD_ICONS[r.kind === 'event' ? 'calendar' : 'briefcase'])}</div>
          <div class="md-item-body">
            <div class="md-item-title">${escapeHTML(r.title || 'Untitled')}</div>
            <div class="md-item-meta">${r.label} · ${escapeHTML(r.meta)}</div>
          </div>
          <div class="md-inline-actions">
            <button class="btn btn-primary md-btn-sm" data-ov-review="${r.id}" data-kind="${r.kind}" data-decision="approved">Approve</button>
            <button class="btn btn-secondary md-btn-sm" data-ov-review="${r.id}" data-kind="${r.kind}" data-decision="rejected">Reject</button>
          </div>
        </div>`).join('')
    : mdEmpty('check', 'All clear', 'Event proposals and opportunity posts from mentors appear here for approval.');

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