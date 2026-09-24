/* AlumNet — shared front-end behaviour
   Forms currently log to console / use mock data.
   Replace the TODO blocks with fetch() calls to the Node/Express API
   once the backend routes exist (see IR-02, IR-03 in the documentation). */

document.addEventListener('DOMContentLoaded', () => {
  wireSignupForm();
  wireLoginForm();
  renderMentorList();
});

function wireSignupForm() {
  const form = document.getElementById('signup-form');
  if (!form) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    // TODO: POST to /api/auth/register (FR-01)
    console.log('Sign up payload', data);
    window.location.href = 'recommendations.html';
  });
}

function wireLoginForm() {
  const form = document.getElementById('login-form');
  if (!form) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    // TODO: POST to /api/auth/login (FR-02)
    console.log('Login payload', data);
    window.location.href = 'recommendations.html';
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
