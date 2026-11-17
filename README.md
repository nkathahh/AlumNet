# AlumNet

![CI](https://github.com/nkathahh/AlumNet/actions/workflows/ci.yml/badge.svg)

An alumni mentorship portal for Kenya Airways. AlumNet matches current staff (mentees)
with former staff (mentors) using semantic text embeddings, and supports mentorship
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
- **Privacy:** privacy notice and consent at sign-up, a record of which notice version each
  member accepted (members are asked to accept a changed notice before carrying on, and can still
  download their data or delete their account if they do not), download my data, delete my account,
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
- **Photos and images:** profile photos, event banners, photos from past events (from the
  organiser and people who registered, with a consent tick), company logos and screenshots
  attached to reports. Every upload is checked and redrawn as WebP at fixed sizes, which proves
  it is a real image and removes hidden details such as a photo's location; the original is
  never kept. Images from mentors wait for an admin, report screenshots are seen only by admins
  and deleted when the report closes, and every image is served only to signed-in members.
  Files go to a local folder or to an S3-compatible bucket such as Cloudflare R2.
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
  readable activity log ("Approved sign-up for Daniel Gitonga (KQ27651) as mentor"); an Admins
  page to add and remove admins, with a second admin approving each change; and account
  recovery: an admin can reset a member's two-factor after checking who they are against the
  phone number HR holds, and the member must set it up again
- **HR stays the source of truth:** when the email HR holds for someone changes (a work email
  becoming a personal one on retirement), their sign-in email follows and both addresses are told
- **Account security:** password rules, change password, forgot password with single-use
  emailed links that expire after 30 minutes, two-factor authentication with an authenticator
  app and one-time backup codes (required for admins), and rate limiting on sign-in, code and reset endpoints
- **Professional profiles:** headline, about, skills, experience, career interests, location,
  LinkedIn and a profile strength guide; a public profile view for other members
- **Mentor matching:** mentors ranked by semantic similarity to the mentee's profile, with a
  breakdown of how skills, experience and goals contribute to each match
- **Mentorship requests:** send, accept, decline, withdraw and end
- **Alumni events:** official events from admins and community events proposed by mentors,
  with registration, capacity limits, admin approval, topics and an optional list of the
  departments an event is mainly for
- **Career opportunities:** posted by mentors with the skills they ask for, approved by admins,
  filterable by type and poster, with a "My posts" tab for the poster
- **Fit for me:** mentees see a fit label on each opportunity (Strong fit, Good fit, Some
  overlap) worked out from the BGE model and the skills they already have, plus a checklist
  ("You have 3 of 5 skills it asks for") showing what is missing. Events are recommended by
  topic, department and the model. Labels are used instead of percentages because similarity
  scores are not probabilities.
- **Targeted alerts:** when a post is approved, members it fits well get one notification
  linking straight to it. Nobody gets more than 3 alerts a week, and alerts can be switched
  off in Settings.
- **Editing live posts and events:** posters can fix a typo, extend a closing date, move a
  venue or close a filled role. Safe edits stay live and registered people are told when the
  date, time, format or venue changes. Changing a link to a site not approved before, or
  anything the scam checks pick up, sends it back to the alumni office first, so an approved
  post cannot be swapped for a scam. Organisers can cancel their event with a reason.
  Registered people are told in the app and by email.
- **Waiting list:** a full event offers a waiting list. When someone cancels or the organiser
  adds places, the next person in line gets the place automatically and is told. In the last
  24 hours, a freed place is offered to everyone waiting instead, so it is not given to someone
  who may not see the message in time.
- **Event reminders and calendars:** everyone registered gets a reminder the day before, in the
  app and by email, and can add any event they registered for to their own calendar (.ics).
- **Search:** events can be searched by title, topic, venue or host and filtered by format and
  date; posters can search their own posts and filter them by status. Long lists show 12 at a
  time.
- **Mentorship workspace and outcomes:** once a mentor accepts, the pair agree up to 8 goals,
  tick them off and log each meeting (date, how they met, length, an optional note). When the
  mentorship ends, each person answers privately: did you meet, how helpful was it (1 to 5),
  how many goals did you reach, and did you feel safe. Only the alumni office sees the
  answers. "I did not feel safe" opens a report straight away.
- **Member detail for admins:** search and filter members by role and status, then open one
  member to see their account, HR record, mentorships with goals, meetings and both ratings,
  mentor response times and average rating (shown only from 3 answers), posts, reports and
  admin history. Opening it is recorded in the activity log.
- **Impact dashboard:** for the last 30 days, 90 days, 12 months or all time: requests,
  acceptance, typical reply time, meetings and goals reached; private outcome ratings; how evenly
  requests are spread across mentors (Gini coefficient and the share going to the busiest fifth);
  events, opportunities, scams stopped and two-factor use. Every chart has its numbers in a
  table, and everything downloads as CSV.
- **Activity log:** filter by who did it, kind of action, dates and words, 50 a page, and
  download as CSV (cells that could run as spreadsheet formulas are made plain text).
- **Mentor shortlist:** mentees can save mentors and compare them before asking, since only 5
  requests can wait at once.
- **Nairobi time:** event times are shown in Nairobi time, with the viewer's own time added for
  alumni abroad. The server stores and compares times in Nairobi time wherever it is hosted.
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
│   ├── scripts/        migrate, start (live), create-admin, backup, restore-check, latency
│   ├── src/            config, controllers, middleware, routes, utils
│   └── tests/          API tests (node --test)
├── frontend/public/    HTML pages, css/style.css, js/main.js, assets, _headers, _routes.json
├── ml-service/         Flask recommendation service, its tests and Dockerfile
│   └── evaluation/     Matching evaluation kit (data, labels, scripts, results)
├── database/           migrations 001 to 028, sample datasets
├── gateway/, functions/  Cloudflare Pages gateway in front of the server
├── deploy/             Server Dockerfile and the Azure setup script
├── e2e/                Browser tests (script injection, accessibility, phone layout)
├── .github/workflows/  CI (tests, coverage, audit) and Deploy (builds the containers)
├── DEPLOYMENT.md       Step-by-step guide to putting AlumNet online
└── USER_GUIDE.md       How mentees, mentors and admins use AlumNet
```

## Running locally

### Requirements

- Node.js 22 or later (24 LTS recommended)
- Python 3.10 or later
- MySQL 8.0

### 1. Database

1. Create the database: `CREATE DATABASE alumnet;`
2. Set the `DB_*` values in `backend/.env` (step 2), then from the `backend` folder run:
   ```
   npm run migrate
   ```
   This applies every file in `database/migrations` that the database has not had yet, in
   order, and records each one in `schema_migrations`, so it is safe to run again at any time.
   `npm run migrate -- --status` lists what is applied and what is waiting.
3. A database set up by hand before the runner existed: run
   `npm run migrate -- --baseline=021` once (021 being the last migration you applied), then
   `npm run migrate` as normal.

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

To create the first admin account: `node scripts/create-admin.js "Full Name" email@example.com password`.
After that, add and remove admins on the **Admins** page of the admin tools.
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
- Two-factor secrets are encrypted in the database with AES-256-GCM (key in `TOTP_ENC_KEY`),
  so a copy of the database alone cannot produce sign-in codes. Backup codes are hashed.
- Repeated failed attempts on sign-in, codes and resets are rate limited, both per network
  address and per account (so guesses spread across many addresses still stop), and the owner is
  told once. The counters are kept in the database, so a restart does not reset them.
- Every signed-in member has a limit of 120 changes an hour (posts, requests, registrations,
  goals, meetings, reports), and at most 3 meetings can be logged per mentorship per day.
- Admin sessions end after 30 minutes without use and 12 hours after signing in; member sessions
  after 14 days without use and 30 days in all. The background check for new notifications does
  not count as use.
- The matching service refuses to start on a public host without its API key, so a forgotten
  setting can never leave it open.
- Email subjects and addresses are always one line, so text typed by members cannot add email
  headers.
- Every page has a Content Security Policy that blocks inline scripts, and all member text is
  escaped before it is shown. A browser test (`e2e/browser.test.js`) types script payloads into
  every field and fails if any page turns them into HTML.
- Live posts are checked again twice a day and straight after a scam rejection: a post whose
  website, email or link has since been blocked is hidden until an admin looks at it. An
  approved post cannot be edited into a scam, because risky edits go back to review.
- When there are two or more admins, an HR import needs a second admin to approve it.
- Deleting an event cancels it and keeps the record, so nothing an admin does erases evidence.
- `npm audit` runs in CI and fails the build on a known high or critical vulnerability in the
  packages the app uses.
- The ML service accepts requests only with a shared API key once it is online.
- Security changes (password, two-factor) create a notification for the account owner.

### How long data is kept

| Data | Kept for |
|---|---|
| Unfinished or refused sign-up requests | 30 days |
| Password reset links | 7 days |
| Read notifications | 180 days |
| Record of alerts sent (to limit them to 3 a week) | 90 days |
| Rate limit counters | 1 day after they expire |
| Admin activity log | 2 years |
| Screenshots attached to a report | until the report is closed |
| Replaced or removed images | deleted straight away |
| Original uploaded image files | never kept (each upload is redrawn as WebP) |
| Mentor profile vectors | until the profile changes or the account is deleted |
| Account, profile, photos and posts | until the member deletes their account |

## Evaluation

The matching engine is evaluated against two baselines, TF-IDF and same-department matching,
using synthetic mentors and mentees with blind relevance labels. Method choices are made on a
development set, and a held-out test set is run once, which the script enforces. See
`ml-service/evaluation/README.md` for the method and steps.

**Results:** the held-out test run (run `20261024_200422`, commit `334dba1`) is complete.
On 10 test mentees and 20 mentors, both embedding methods reached Hit@3 0.90 and MRR 0.86,
against 0.70 for the department baseline and Hit@3 0.90 with MRR 0.93 for TF-IDF. The
embeddings did not beat TF-IDF, and the two failed on different mentees. Full results are in
`ml-service/evaluation/results` and Chapter 5 of the project report.

## Testing

### Automated tests (GitHub Actions)

Every push and pull request to `main` runs `.github/workflows/ci.yml`. Each job starts an
empty MySQL 8 database, builds it from `database/migrations` and tests the real code:

- **Backend API tests** (`backend/tests/api.test.js`, 96 tests): sign-up by HR email match,
  the alumni office review path with risk signals, impostor detection, roles from HR, HttpOnly
  session cookies, CSRF protection, log out everywhere, suspension, single-use reset links,
  two-factor with backup codes, admin 2FA requirement, HR import with retirement conversion,
  profile privacy, data export and deletion, scam checks, reports and auto-hiding, blocking,
  contact sharing after acceptance, moderation lanes and trust, request changes and resubmit,
  learning from approvals and scam rejections, the mentor directory and its filters, gender
  consent, mentor capacity (including two accepts at the same moment), request expiry, search
  fallback, filter counts, paging, removal of embeddings on account deletion, skill coverage and
  fit labels, event targeting, alert limits and opt-out, editing live posts and events, the waiting list, event reminders, the mentor shortlist, mentorship goals, meetings and private
  feedback, member detail, the impact figures, activity log filters and export, encrypted two-factor secrets, second-admin
  approval of HR imports, re-checking live posts after a scam, length and type checks on every
  post and event field, privacy notice versions, a backup restored with every row checked,
  two-factor reset after an identity check, adding and removing admins with a second admin,
  account emails following HR, mentee and mentor ratings kept apart, security headers and rate
  limiting. CI measures coverage with c8 (about 90% of backend lines and 70% of branches) and
  fails if it drops below 80% of lines or 65% of branches; run `npm run coverage` locally.
- **Browser checks** (`e2e/browser.test.js`): script payloads in every field members can type
  into, checked on every page for every role; an axe-core accessibility check (WCAG 2.1 AA) of the
  main pages and the busiest admin screens in light and dark mode; keyboard focus kept inside
  dialogs and returned afterwards; every page checked at phone width (390px) for sideways
  scrolling; and the prompt to accept a changed privacy notice. CI also runs `npm audit` and `pip-audit`.
- **Recommendation service tests** (`ml-service/tests/test_app.py`): the API key check, input
  errors, a ranking check with the real BGE model on seeded synthetic profiles, the embedding
  cache, search by meaning and scoring of opportunities and events.

Results appear as a tick or cross next to each commit on GitHub, and each run keeps the
test reports as downloadable artifacts.

To run the backend tests locally, run this in PowerShell from the `backend` folder.
`--fresh` empties and rebuilds the test database (it only works on names ending in `_test`),
because the tests need an empty one. The connection settings come from your `.env`; every
other setting is fixed by the tests, so local choices such as two-factor being off do not
change the results:

```
$env:DB_NAME="alumnet_test"; npm run migrate -- --fresh; npm test
```

Afterwards run `Remove-Item Env:DB_NAME` so later commands in that window use your normal
database again.

The tests refuse to run against any database whose name does not end in `_test`.

### Manual test cases

Functional test cases TC-01 to TC-38 cover the user journeys across all roles. Each one is
automated and runs in CI. The cases, their traceability to the requirements and the results
are in Chapter 5 of the project report.

## Known limitations and outstanding defects

- **Small synthetic evaluation:** the matching evaluation used 20 synthetic mentors and
  15 synthetic mentees, so ten test mentees cannot separate methods of similar quality, and
  the results may not hold for real staff.
- **Usability study:** the System Usability Scale study with representative users runs from
  17 to 21 November 2026. Until then the interface has only passed the automated
  accessibility check (axe-core, WCAG 2.1 AA) on the main pages.
- **Ranking method:** the live service ranks mentors by whole-profile similarity and uses the
  field similarities to explain each match. The field-weighted method chosen on the
  development set scored the same on the test set.
- **Response time:** live, 90% of recommendation requests finish within 3 seconds (target
  95%), because the server and the database are in different regions.
- **Scam checks are rules, not a model:** text inside images and links whose page changes after
  approval are not caught; reports from members and the re-check are the backstop.
- **Single-admin installations** cannot use the second-admin rule for HR imports or for adding
  the second admin; the log records that no second check was possible.
- **Two-factor library:** otplib is kept on version 12. Version 13 rejects the shorter secrets
  that existing accounts already use, so upgrading needs a planned move of every two-factor
  user to a new secret.
- **Events have no end time:** calendar files assume two hours.
- **Notifications:** updated every 60 seconds by polling, not in real time. Event changes and
  cancellations are also emailed; other notifications are in the app only.
- **Free hosting:** the online version sleeps when idle, so the first visit can take up to a
  minute.

## AI assistance

AI tools (Claude, Anthropic) assisted with code, tests, the deployment configuration, the
evaluation design and drafting the synthetic profiles. The author reviewed and tested every
suggestion before keeping it. Relevance labels were made by two human judges who could not
see model scores or each other's labels. A language model settled the 80 pairs on which they
disagreed; its labels are kept separately in `ml-service/evaluation/labels/pooled/judge_C.csv`
and are reported as a model judge.

## Licence and access

Shared for academic assessment at Strathmore University. All rights reserved: no licence is
granted to reuse or redistribute the code. The embedding model BAAI/bge-small-en-v1.5 is
used under its MIT licence.
