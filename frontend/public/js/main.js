document.addEventListener('DOMContentLoaded', () => {
  wireAuthToggleTransition();
  initTheme();
  guardRoute();
  renderSidebar();
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
});

const API_BASE = 'http://localhost:4000/api';

const HOME_PAGE = { mentee: 'recommendations.html', mentor: 'requests.html', admin: 'admin.html' };

const PAGE_ROLES = {
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

function apiMentorCardHTML(m, alreadyRequested) {
  const initials = m.name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return `
    <article class="mentor-card">
      <div class="mentor-avatar">${initials}</div>
      <div>
        <div class="mentor-name-row">
          <span class="mentor-name" style="cursor:pointer; text-decoration:underline;" data-action="view-profile" data-mentor-id="${m.mentor_id}">${m.name}</span>
          <span class="match-score">${m.score}% match</span>
        </div>
        <div class="mentor-tags">${m.matched_attributes.map((t) => `<span class="tag">${t}</span>`).join('')}</div>
        <div class="mentor-meta">${m.department || ''}${m.years_of_experience ? ' · ' + m.years_of_experience + ' yrs experience' : ''}</div>
      </div>
      <div class="mentor-actions">
        <button class="btn ${alreadyRequested ? 'btn-secondary' : 'btn-primary'}" data-action="request" data-mentor-id="${m.mentor_id}" ${alreadyRequested ? 'disabled' : ''}>
          ${alreadyRequested ? 'Requested' : 'Request'}
        </button>
        <button class="icon-btn" data-action="bookmark" data-mentor-id="${m.mentor_id}" aria-label="Bookmark mentor">★</button>
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
    const res = await fetch(`${API_BASE}/profile/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      form.skills.value = data.skills || '';
      form.experience.value = data.experience || '';
      form.interests.value = data.career_interests || '';
      if (data.industry) form.industry.value = data.industry;
    }
  } catch (err) {
    console.error('Could not load profile', err);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
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
      alert('Profile saved.');
    } catch (err) {
      console.error(err);
    }
  });
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

const MOCK_EVENTS = [
  { title: 'Cabin Crew Reunion', date: 'Sep 14, 2026 · Nairobi', desc: 'A reunion for former cabin crew with panels on career transitions and networking.' },
  { title: 'Safety & Training Workshop', date: 'Aug 29, 2026 · Virtual', desc: 'Interactive sessions with veteran trainers on modern safety procedures.' }
];

function renderEvents() {
  const grid = document.getElementById('event-grid');
  if (!grid) return;
  // TODO: replace MOCK_EVENTS with GET /api/events
  grid.innerHTML = MOCK_EVENTS.map((e) => `
    <div class="event-card">
      <div class="date">${e.date}</div>
      <h3>${e.title}</h3>
      <p>${e.desc}</p>
      <button class="btn btn-primary btn-block" data-action="register">Register</button>
    </div>`).join('');
}

/* --------------------------------------------------------------------
   Career opportunities (FR-09) — mentee/mentor view, still mock
   -------------------------------------------------------------------- */

const MOCK_OPPORTUNITIES = [
  { title: 'Senior Cabin Services Trainer', tag: 'Aviation', desc: 'Lead training programs for cabin crew and develop updated safety curricula.', by: 'Mercy Wanjiru' },
  { title: 'Ground Operations Coordinator', tag: 'Logistics', desc: 'Coordinate ramp activities and ensure smooth turnaround.', by: 'Samuel Otieno' }
];

function renderOpportunities() {
  const list = document.getElementById('opportunities-list');
  if (!list) return;
  // TODO: replace MOCK_OPPORTUNITIES with GET /api/opportunities
  list.innerHTML = MOCK_OPPORTUNITIES.map((o) => `
    <div class="opportunity-card">
      <div>
        <span class="tag">${o.tag}</span>
        <h3 style="font-size:1rem; margin: 6px 0;">${o.title}</h3>
        <p class="mentor-blurb">${o.desc}</p>
        <div class="mentor-meta">Posted by ${o.by}</div>
      </div>
      <button class="btn btn-secondary">View</button>
    </div>`).join('');
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

function wireAdminTabs() {
  const tabLinks = document.querySelectorAll('[data-admin-tab]');
  if (!tabLinks.length) return;
  tabLinks.forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      tabLinks.forEach((l) => l.classList.remove('active'));
      link.classList.add('active');
      ['users', 'events', 'opportunities', 'logs'].forEach((name) => {
        document.getElementById(`admin-tab-${name}`).style.display = name === link.dataset.adminTab ? 'block' : 'none';
      });
    });
  });
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
    const title = document.getElementById('eventTitle').value;
    const eventDate = document.getElementById('eventDate').value;
    const description = document.getElementById('eventDescription').value;

    const res = await fetch(`${API_BASE}/admin/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title, eventDate, description })
    });
    if (res.ok) {
      form.reset();
      document.getElementById('eventDescription').value = '';
      renderAdminEvents();
      renderAdminLogs();
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
        <span class="tag">${o.industry || ''}</span>
        <h3 style="font-size:1rem; margin:6px 0;">${o.title}</h3>
        <p class="mentor-blurb">${o.description || ''}</p>
        <div class="mentor-meta">Posted by ${o.posted_by_name}</div>
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

const MOCK_NOTIFICATIONS = [
  { message: 'Mark Thuo accepted your mentorship request.', time: '2h ago', unread: true },
  { message: 'Safety & Training Workshop starts in 3 days.', time: '1d ago', unread: false }
];

function renderNotifications() {
  const list = document.getElementById('notif-list');
  if (!list) return;
  // TODO: replace MOCK_NOTIFICATIONS with GET /api/notifications
  list.innerHTML = MOCK_NOTIFICATIONS.map((n) => `
    <div class="notif-item ${n.unread ? 'unread' : ''}">
      <span class="notif-dot" style="${n.unread ? '' : 'background:transparent;'}"></span>
      <div><div>${n.message}</div><div class="mentor-meta">${n.time}</div></div>
    </div>`).join('');
}