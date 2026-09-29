/* AlumNet — shared front-end behaviour
   Forms currently log to console / use mock data.
   Replace the TODO blocks with fetch() calls to the Node/Express API
   once the backend routes exist (see IR-02, IR-03 in the documentation). */

document.addEventListener('DOMContentLoaded', () => {
  wireSignupForm();
  wireLoginForm();
  renderMentorList();
  renderRequests();
  wireProfileForm();
  renderEvents();
  renderOpportunities();
  renderAdminTable();
  renderNotifications();
});

const API_BASE = 'http://localhost:4000/api';

function wireSignupForm() {
  const form = document.getElementById('signup-form');
  if (!form) return;

  const roleSelect = document.getElementById('role');
  const menteeFields = document.getElementById('mentee-fields');
  const mentorFields = document.getElementById('mentor-fields');
  const staffNumberInput = document.getElementById('staffNumber');
  const staffStatus = document.getElementById('staff-lookup-status');
  const errorEl = document.getElementById('signup-error');
  let verifiedStaff = null;

  roleSelect.addEventListener('change', () => {
    const isMentee = roleSelect.value === 'mentee';
    menteeFields.style.display = isMentee ? 'block' : 'none';
    mentorFields.style.display = roleSelect.value === 'mentor' ? 'block' : 'none';
  });

  staffNumberInput.addEventListener('blur', async () => {
    verifiedStaff = null;
    document.getElementById('fullNameMentee').value = '';
    document.getElementById('emailMentee').value = '';
    if (!staffNumberInput.value) { staffStatus.textContent = ''; return; }

    staffStatus.textContent = 'Checking...';
    try {
      const res = await fetch(`${API_BASE}/auth/staff-lookup?staffNumber=${encodeURIComponent(staffNumberInput.value)}`);
      const data = await res.json();
      if (!res.ok) {
        staffStatus.textContent = data.error || 'Staff number not found';
        return;
      }
      verifiedStaff = data;
      document.getElementById('fullNameMentee').value = data.full_name;
      document.getElementById('emailMentee').value = data.kq_email;
      staffStatus.textContent = `Verified: ${data.full_name} (${data.department})`;
    } catch {
      staffStatus.textContent = 'Could not reach the server.';
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.style.display = 'none';

    const role = roleSelect.value;
    if (role === 'mentee' && !verifiedStaff) {
      errorEl.textContent = 'Enter your staff number and wait for it to verify.';
      errorEl.style.display = 'block';
      return;
    }

    const common = {
      password: document.getElementById('password').value,
      idNumber: document.getElementById('idNumber').value,
      mobileNumber: document.getElementById('mobileNumber').value || undefined,
      country: document.getElementById('country').value,
      city: document.getElementById('city').value,
      skills: document.getElementById('skills').value,
      experience: document.getElementById('experience').value,
      careerInterests: document.getElementById('interests').value,
      industry: document.getElementById('industry').value
    };

    const payload = role === 'mentee'
      ? { ...common, role, staffNumber: staffNumberInput.value }
      : {
          ...common,
          role,
          name: document.getElementById('fullNameMentor').value,
          email: document.getElementById('emailMentor').value,
          staffNumber: document.getElementById('staffNumberMentor').value || undefined
        };

    try {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await res.json();
      if (!res.ok) {
        errorEl.textContent = result.error || 'Registration failed';
        errorEl.style.display = 'block';
        return;
      }
      localStorage.setItem('alumnet_token', result.token);
      localStorage.setItem('alumnet_role', result.role);
      window.location.href = 'recommendations.html';
    } catch {
      errorEl.textContent = 'Could not reach the server. Is the backend running on port 4000?';
      errorEl.style.display = 'block';
    }
  });
}

function wireLoginForm() {
  const form = document.getElementById('login-form');
  if (!form) return;
  const errorEl = document.getElementById('login-error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));

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
        return;
      }

      localStorage.setItem('alumnet_token', result.token);
      localStorage.setItem('alumnet_role', result.role);
      window.location.href = 'recommendations.html';
    } catch (err) {
      errorEl.textContent = 'Could not reach the server. Is the backend running on port 4000?';
      errorEl.style.display = 'block';
    }
  });
}


/* --------------------------------------------------------------------
   Mentor recommendations (FR-04) — mock data standing in for a call to
   GET /api/recommendations until the Python matching service is wired up.
   -------------------------------------------------------------------- */

const MOCK_MENTORS = [
  {
    initials: 'MT',
    name: 'Mark Thuo',
    match: 95,
    tags: ['Flight Ops', 'Crew Scheduling', 'Route Planning'],
    blurb: 'Former Head of Flight Operations with 15 years experience across intercontinental routes.',
    meta: '3 mutual connections',
    saved: false
  },
  {
    initials: 'RN',
    name: 'Ruth Njoroge',
    match: 89,
    tags: ['Cabin Services', 'Customer Experience', 'Training'],
    blurb: 'Ex-Cabin Services Manager focused on guest experience and crew coaching.',
    meta: '5 mentees',
    saved: true
  },
  {
    initials: 'CS',
    name: 'Caroline Sande',
    match: 81,
    tags: ['Ground Ops', 'Ramp Coordination', 'Logistics'],
    blurb: 'Director at Ground Services with deep knowledge of airport operations and turnaround processes.',
    meta: 'Available next month',
    saved: false
  }
];

function renderMentorList() {
  const list = document.getElementById('mentor-list');
  if (!list) return;

  // TODO: replace MOCK_MENTORS with the response of
  // GET /api/recommendations?menteeId=... (backed by RecommendationEngine)
  list.innerHTML = MOCK_MENTORS.map(mentorCardHTML).join('');

  list.querySelectorAll('[data-action="bookmark"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('saved');
      // TODO: POST/DELETE /api/bookmarks/:mentorId
    });
  });

  list.querySelectorAll('[data-action="request"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.textContent = 'Requested';
      btn.disabled = true;
      // TODO: POST /api/mentorship-requests (FR-05)
    });
  });
}

function mentorCardHTML(m) {
  return `
    <article class="mentor-card">
      <div class="mentor-avatar">${m.initials}</div>
      <div>
        <div class="mentor-name-row">
          <span class="mentor-name">${m.name}</span>
          <span class="match-score">${m.match}% match</span>
        </div>
        <div class="mentor-tags">
          ${m.tags.map((t) => `<span class="tag">${t}</span>`).join('')}
        </div>
        <p class="mentor-blurb">${m.blurb}</p>
        <div class="mentor-meta">${m.meta}</div>
      </div>
      <div class="mentor-actions">
        <button class="btn btn-primary" data-action="request">Request</button>
        <button class="icon-btn ${m.saved ? 'saved' : ''}" data-action="bookmark" aria-label="Bookmark mentor">★</button>
      </div>
    </article>`;
}



/* --------------------------------------------------------------------
   Mentorship requests (FR-05, FR-06)
   -------------------------------------------------------------------- */
const MOCK_REQUESTS = [
  { name: 'Jordan Matthews', date: 'Jul 30, 2026', status: 'pending', note: 'Looking for guidance on transitioning to senior operations roles in aviation.' },
  { name: 'Lina Shah', date: 'Jun 12, 2026', status: 'accepted', note: 'Ongoing mentorship covering interview prep and operations portfolio review.' }
];

function renderRequests() {
  const list = document.getElementById('requests-list');
  if (!list) return;

  let activeTab = 'pending';
  const tabs = document.querySelectorAll('.tab');

  function draw() {
    const filtered = MOCK_REQUESTS.filter((r) => r.status === activeTab);
    list.innerHTML = filtered.length
      ? filtered.map(requestCardHTML).join('')
      : `<p style="color: var(--slate); padding: 20px 4px;">No ${activeTab} requests.</p>`;

    list.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        // TODO: PATCH /api/mentorship-requests/:id with { status: btn.dataset.action }
        console.log('Request action', btn.dataset.action);
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

  // TODO: replace MOCK_REQUESTS with GET /api/mentorship-requests
  draw();
}

function requestCardHTML(r) {
  return `
    <div class="request-card">
      <div>
        <strong>${r.name}</strong><br>
        <span style="font-size:0.82rem; color:var(--slate);">Requested on ${r.date}</span>
        <p class="mentor-blurb" style="margin-top:8px;">${r.note}</p>
      </div>
      ${r.status === 'pending'
        ? `<div style="display:flex; gap:8px;">
             <button class="btn btn-primary" data-action="accepted">Accept</button>
             <button class="btn btn-secondary" data-action="declined">Decline</button>
           </div>`
        : `<span class="request-status ${r.status}">${r.status}</span>`}
    </div>`;
}

/* --------------------------------------------------------------------
   Profile (FR-03)
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

/* --------------------------------------------------------------------
   Events (FR-07, FR-08)
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
   Career opportunities (FR-09)
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
   Admin dashboard (FR-12)
   -------------------------------------------------------------------- */
const MOCK_ADMIN_STATS = [
  { num: '8,412', label: 'Total alumni' },
  { num: '312', label: 'Active mentorships' },
  { num: '21', label: 'Pending requests' },
  { num: '7', label: 'Flagged accounts' }
];

const MOCK_USERS = [
  { name: 'Olivia Park', email: 'olivia.park@kenyaairways...', role: 'Mentor', status: 'Active', joined: 'Jan 10, 2025' },
  { name: 'Ravi Patel', email: 'ravi.patel@kenyaairways...', role: 'Mentee', status: 'Active', joined: 'Mar 4, 2026' },
  { name: 'Monica Reyes', email: 'monica.reyes@kenyaairwa...', role: 'Mentor', status: 'Flagged', joined: 'Jul 2, 2024' }
];

function renderAdminTable() {
  const statRow = document.getElementById('stat-row');
  const tbody = document.getElementById('admin-table-body');
  if (!statRow || !tbody) return;

  // TODO: replace both mock arrays with GET /api/admin/users (FR-12)
  statRow.innerHTML = MOCK_ADMIN_STATS.map((s) => `
    <div class="stat-card"><div class="num">${s.num}</div><div class="label">${s.label}</div></div>`).join('');

  tbody.innerHTML = MOCK_USERS.map((u) => `
    <tr>
      <td>${u.name}</td><td>${u.email}</td><td>${u.role}</td><td>${u.status}</td><td>${u.joined}</td>
      <td><button class="btn btn-secondary" data-action="toggle-status">${u.status === 'Flagged' ? 'Reactivate' : 'Suspend'}</button></td>
    </tr>`).join('');
}

/* --------------------------------------------------------------------
   Notifications
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
