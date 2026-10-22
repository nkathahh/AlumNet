# AlumNet

![CI](https://github.com/nkathahh/AlumNet/actions/workflows/ci.yml/badge.svg)

An alumni mentorship portal for Kenya Airways. AlumNet matches current staff (mentees)
with retired staff (mentors) using semantic text embeddings, and supports mentorship
requests, alumni events, career opportunities and notifications, with an admin console
for moderation.

Final-year capstone project, Bachelor of Informatics and Computer Science,
Strathmore University.

## Features

- **Verified sign-up:** people enter only their staff number and email. If the email is the
  one Kenya Airways HR holds (work email for current staff, personal email for former staff),
  they set a password or use Google and are in. Otherwise the alumni office reviews the request
  with the evidence already compared against HR (name, phone, attempts) and a risk level. The
  reply is the same whatever is entered, so the form cannot be used to look up staff.
- **Roles from HR, not a dropdown:** current staff are mentees and former staff are mentors.
  The role is checked at every login and after every HR import, so a retiring employee becomes
  a mentor automatically and their open mentee requests are closed.
- **Sessions:** an HttpOnly cookie (not readable by page scripts), CSRF protection, log out
  everywhere, and sessions that end at once on suspension, password change or HR changes
- **Privacy:** privacy notice and consent at sign-up, download my data, delete my account,
  automatic clean-up of old sign-up records, and mentee profiles visible only to mentors they
  have contacted
- **Trust and safety:** verified badges on profiles and match cards, mentees introduce
  themselves when asking for mentorship, contact details are shared only after a mentor
  accepts, members can report profiles, opportunities and events and block someone, and a post
  reported by three people is hidden until reviewed. Opportunities and events get automatic scam
  checks (fees, M-Pesa, WhatsApp, ID or bank requests, fake Kenya Airways links, shortened links,
  common Swahili phrases and simple disguises like "f.e.e"). Reassurances such as "there is no
  fee" are not flagged. The same checks read mentorship request messages and profile text; a
  high-risk result warns the mentor and files a report from "Automatic check". High-risk posters
  are told only that their post needs a closer review, so scammers cannot learn the rules. Mentees can have at most
  five requests waiting and cannot re-ask a mentor who declined within 30 days.
- **Smart moderation:** each post is sorted into a lane. *Hold* (high risk, a blocked website,
  email or link, a burst of posts or one link shared by several accounts) is never published
  automatically. *Queue* needs an admin. *Fast lane* publishes straight away, but only when the
  alumni office switches it on and the poster is trusted (verified former staff, account 30+
  days old, 2 admin-approved posts, nothing rejected as a scam, no upheld reports, two-factor on)
  and the link is a known employer website with no warnings. Admins approve, request changes
  (the poster edits and resubmits) or reject with a reason the poster sees. Approvals teach the
  system known employer websites; scam rejections block the website, email or exact link for
  every account. Clean posts can be approved in one click, automatic approvals are listed for
  spot-checks and can be taken down, and an accuracy panel compares the automatic checks with
  admin decisions. Admins are reminded about posts waiting more than 48 hours; waiting never
  approves anything.
- **Find a mentor:** a "Recommended for you" list from the matching model, then a directory of
  every mentor with search by meaning (the BGE model compares what you type with each profile,
  so "help moving into management" finds "led a team of 40"), filters for department,
  experience, location, meeting mode and gender, sorting, and pages of 12. Filters are kept in
  the address so links and the back button work. If the matching service is down, search falls
  back to exact words and says so.
- **Mentor capacity:** mentors choose whether they take mentees, how many at a time, how they
  meet and when they are free. Full or paused mentors are not recommended and cannot be sent
  requests, a mentor cannot accept past their limit, and mentors with more free places come
  first when two matches are almost equal, so popular mentors are not flooded.
- **Gender with consent:** gender is optional and only used in the mentor filter when the mentor
  agrees. It is never shown on profiles.
- **Faster matching:** mentor profile vectors are cached in the database and only re-encoded
  when a profile changes. They are deleted when an account is deleted, because they are worked
  out from personal data.
- **Fair waiting:** a request with no reply after 14 days expires, and mentees are told when a
  mentor they are waiting on becomes full or pauses, so they can ask someone else.
- **Admin tools:** identity verification queue, HR records import with a preview of changes,
  a user table with role, department, last activity and 2FA, suspensions with a reason, and a
  readable activity log ("Approved sign-up for Daniel Gitonga (KQ27651) as mentor")
- **Account security:** password rules, change password, forgot password with single-use
  emailed links that expire after 30 minutes, two-factor authentication with an authenticator
  app and one-time backup codes (required for admins), and rate limiting on sign-in, code and reset endpoints
- **Professional profiles:** headline, about, skills, experience, career interests, location,
  LinkedIn and a profile strength guide; a public profile view for other members
- **Mentor matching:** mentors ranked by semantic similarity to the mentee's profile, with a
  breakdown of how skills, experience and goals contribute to each match
- **Mentorship requests:** send, accept, decline, withdraw and end
- **Alumni events:** official events from admins and community events proposed by mentors,
  with registration, capacity limits and admin approval
- **Career opportunities:** posted by mentors, approved by admins, filterable by type
- **Notifications:** for requests, approvals, event changes and security changes
- **Dashboards:** a home page for each role with live stats and action items
- **Admin console:** overview, user suspension, event management, content moderation and an
  activity log

## Architecture

| Component | Technology | Local address |
|---|---|---|
| Frontend | HTML, CSS, vanilla JavaScript, served by the backend | http://localhost:4000 |
| Backend API | Node.js, Express, JWT, bcrypt | http://localhost:4000/api |
| Database | MySQL 8.0 (database `alumnet`) | localhost:3306 |
| ML service | Python, Flask, sentence-transformers (BAAI/bge-small-en-v1.5) | http://localhost:5000 |

The browser loads the pages from the backend and calls the API on the same server. The
backend reads and writes MySQL and calls the ML service for recommendations. The ML service
encodes mentee and mentor profiles and ranks mentors by cosine similarity.

## Project structure

```
AlumNet/
├── backend/            Express API and the server for the frontend
│   ├── scripts/        create-admin.js
│   └── src/            config, controllers, middleware, routes, utils
├── frontend/public/    HTML pages, css/style.css, js/main.js, assets
├── ml-service/         Flask recommendation service and deployment Dockerfile
│   └── evaluation/     Matching evaluation kit (data, labels, scripts, results)
├── database/           schema.sql, migrations 001 to 010, sample datasets
└── DEPLOYMENT.md       Step-by-step guide to putting AlumNet online
```

## Running locally

### Requirements

- Node.js 18 or later
- Python 3.10 or later
- MySQL 8.0

### 1. Database

1. Create the database: `CREATE DATABASE alumnet;`
2. Run the files in `database/migrations` in order, 001 to 010, in MySQL Workbench.

### 2. Environment variables

Copy `backend/.env.example` to `backend/.env` and `ml-service/.env.example` to
`ml-service/.env`, then fill in the values. **Never commit `.env` files**; they are listed in
`.gitignore`. Google sign-in needs `GOOGLE_CLIENT_ID`, and password reset emails need either
the Gmail settings (`SMTP_USER`, `SMTP_PASS`) or `BREVO_API_KEY`. Without email settings,
reset links are printed in the backend terminal instead.

### 3. Backend and frontend

```
cd backend
npm install
npm start
```

### 4. ML service (second terminal)

```
cd ml-service
python -m venv venv
venv\Scripts\activate          (Windows)
source venv/bin/activate       (macOS or Linux)
pip install -r requirements.txt
python app.py
```

The first run downloads the embedding model (about 130 MB).

### 5. Open the app

Go to **http://localhost:4000**. Opening the HTML files directly from the folder still works
for most pages, but Google sign-in only works when the app is opened through the server.

To create an admin account: `node scripts/create-admin.js "Full Name" email@example.com password`.
Admin tools stay locked until that admin turns on two-factor authentication in Account
settings. For local development only, `ADMIN_2FA_REQUIRED=false` in `backend/.env` skips this.
from the `backend` folder.

## Demo accounts

| Role | Name | Login | Password |
|---|---|---|---|
| Mentee | Joyce | [email] | available on request |
| Mentor | Brian | [email] | available on request |
| Mentor | Ruth Njoroge | [email] | available on request |
| Admin | Admin | [email] | available on request |

All demo data is synthetic and does not describe real Kenya Airways staff. Set
`MAIL_DEV_REDIRECT` to your own inbox so test emails to made-up addresses never reach anyone.

## Security design

- Passwords are hashed with bcrypt and must be at least 8 characters with letters and numbers.
- Sign-in errors do not reveal whether an account exists, and the forgot-password form gives
  the same reply either way.
- Reset links are random 256-bit tokens; only their SHA-256 hash is stored. Each link works
  once, expires after 30 minutes, and a new request cancels older links.
- Two-factor authentication uses time-based one-time passwords (RFC 6238). After the password
  step the server issues a 5-minute token that only the code check accepts.
- Google sign-in verifies Google's signed ID token on the server and only logs in accounts
  that already exist, so staff-number verification at registration cannot be skipped.
- Repeated failed attempts on sign-in, codes and resets are rate limited per address.
- The ML service accepts requests only with a shared API key once it is online.
- Security changes (password, two-factor) create a notification for the account owner.

## Evaluation

The matching engine is evaluated against two baselines, TF-IDF and same-department matching,
using synthetic mentors and mentees with blind relevance labels. Method choices are made on a
development set, and a held-out test set is run once, which the script enforces. See
`ml-service/evaluation/README.md` for the method and steps.

**Current status:** the evaluation kit and pilot runs are complete. Relevance labelling is in
progress, and the full development and test results will follow.

## Testing

### Automated tests (GitHub Actions)

Every push and pull request to `main` runs `.github/workflows/ci.yml`. Each job starts an
empty MySQL 8 database, builds it from `database/migrations` and tests the real code:

- **Backend API tests** (`backend/tests/api.test.js`, 62 tests): sign-up by HR email match,
  the alumni office review path with risk signals, impostor detection, roles from HR, HttpOnly
  session cookies, CSRF protection, log out everywhere, suspension, single-use reset links,
  two-factor with backup codes, admin 2FA requirement, HR import with retirement conversion,
  profile privacy, data export and deletion, scam checks, reports and auto-hiding, blocking,
  contact sharing after acceptance, moderation lanes and trust, request changes and resubmit,
  learning from approvals and scam rejections, the mentor directory and its filters, gender
  consent, mentor capacity (including two accepts at the same moment), request expiry, search
  fallback, filter counts, paging, removal of embeddings on account deletion, security headers
  and rate limiting.
- **Recommendation service tests** (`ml-service/tests/test_app.py`): the API key check, input
  errors, a ranking check with the real BGE model on seeded synthetic profiles, the embedding
  cache and search by meaning.

Results appear as a tick or cross next to each commit on GitHub, and each run keeps the
test reports as downloadable artifacts.

To run the backend tests locally, create an empty `alumnet_test` database, apply the
migrations to it, then run this in PowerShell from the `backend` folder (the other database
settings come from your `.env`):

```
$env:DB_NAME="alumnet_test"; npm test
```

The tests refuse to run against any database whose name does not end in `_test`.

### Manual test cases

Functional test cases TC-01 to TC-27 cover the user journeys across all roles. Results and
screenshots are in Chapter 5 of the project report.

## Known limitations and outstanding defects

- **Evaluation incomplete:** relevance labelling and the final test run are still to be done.
  Current evidence comes from the pilot runs.
- **Known ranking error:** for one mentee (Joyce), a mentor with strong skills overlap
  (Catherine) ranks above the better overall fit (Brian). Field-weighted scoring corrected this
  in the pilot, but only narrowly, and the full evaluation will test it.
- **Compressed scores:** BGE similarity scores fall in a narrow range, so displayed match
  percentages look closer together than the real differences in fit.
- **No embedding cache:** mentor profiles are re-encoded on every request, so response time
  grows with the number of mentors.
- **Sessions after a password change:** existing logins on other devices stay valid until their
  token expires (7 days).
- **Two-factor recovery:** there are no backup codes yet; an admin would need to reset 2FA for a
  user who loses their phone.
- **Inconsistent output escaping:** newer pages escape user text before display; some older
  admin tables do not yet.
- **Duplicate table:** the original `event_participation` table duplicates
  `event_registrations` and is to be removed.
- **Notifications:** updated every 60 seconds by polling, not in real time.
- **Free hosting:** the online version sleeps when idle, so the first visit can take up to a
  minute.

## AI assistance

AI tools assisted with code, the evaluation design and drafting synthetic profiles. All
suggestions were reviewed, tested and either accepted or rejected by the author. Relevance
labels were created by the author without AI, so the model is not judged by another model.
