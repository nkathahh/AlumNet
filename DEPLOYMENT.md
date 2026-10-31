# Deploying AlumNet

AlumNet is deployed on free plans, following the routes in the course's Sprint III
deployment guide: **Cloudflare** for the public address and gateway (Example 1) and
**Hugging Face Docker Spaces** for the server and the model (Example 3, Route A).

```
Browser ──HTTPS──▶ Cloudflare Pages ──(gateway secret)──▶ Hugging Face Space: alumnet-api
                    pages + gateway                          Node/Express server
                    function                                  │            │
                                                              │ ML_API_KEY │ TLS
                                                              ▼            ▼
                                             Hugging Face Space:     Aiven MySQL
                                             alumnet-ml (BGE model)  (managed database)
```

| Part | Host | Where it is in the course guide |
|---|---|---|
| Pages and gateway | Cloudflare Pages, deployed from GitHub `main` | Example 1, steps 3 to 6 |
| Server (Express API) | Hugging Face Docker Space `alumnet-api` | Example 3, Route A ("a Docker Space when a custom runtime is needed") |
| Matching model | Hugging Face Docker Space `alumnet-ml`, pinned model revision | Example 3, Route A |
| Database | Aiven for MySQL, free plan | Example 2: "an appropriate managed database" |
| Releases | GitHub Actions: tests, then publish to both Spaces | Example 3: "synchronising Spaces with GitHub Actions" |

**Why this combination.** Cloudflare Pages serves static pages and small functions, so it
cannot run the Express server and its MySQL connection; the guide itself notes that Pages
"serves the frontend, not" a backend. The AWS route (Example 2) uses billable resources, and no
credit is provided. A Docker Space runs the unchanged server for free, and the Pages function
acts as the gateway in front of it. None of the course examples hosts MySQL, so the database is
on Aiven's free plan, with an encrypted connection. Agree this route with the supervisor.

**Why the gateway is a Pages Function, not a separate Worker.** Example 1 puts the gateway on
its own `api.` subdomain of a custom domain. AlumNet's sign-in uses a first-party cookie on the
same address as the pages, and there is no paid domain yet, so the gateway runs as a Pages
Function (a Cloudflare Worker that Pages deploys with the site) on the same address. If you
later register the free Namecheap `.me` domain from the GitHub Student Pack, attach it in
Pages → Custom domains (Example 1, steps 1, 2 and 5); nothing else changes.

Do the steps in order: each one needs details from the one before. Keep a private note of
every password and key. Never put them in the repository.

## Before you start

Generate four random secrets. In PowerShell, run this four times and keep the results:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

They are `JWT_SECRET`, `ML_API_KEY`, `TOTP_ENC_KEY` and `GATEWAY_SECRET`. If you are copying your
local database (step 1), use your local `JWT_SECRET` and `TOTP_ENC_KEY` instead, so existing
two-factor codes keep working. Never change `TOTP_ENC_KEY` after people turn on two-factor.

## 1. Database on Aiven

1. Sign up at aiven.io (no card needed) and create a service: **MySQL**, **Free plan**.
2. When it is running, note the **Host**, **Port**, **User** (`avnadmin`) and **Password**, and
   download the **CA certificate** (`ca.pem`).
3. In MySQL Workbench, add a connection to Aiven with those details. On the **SSL** tab set
   *Use SSL* to **Require and Verify CA** and choose `ca.pem`. Test the connection.
4. Either start empty (the server creates every table itself on first start), or copy your
   local data:
   1. Connect to your **local** database. **Server → Data Export**, tick `alumnet`, choose
      **Dump Structure and Data** and **Export to Self-Contained File**. Under
      **Advanced Options**, set **set-gtid-purged** to **OFF**.
   2. Connect to **Aiven**. **Server → Data Import**, pick the file and set the
      **Default Target Schema** to a new schema called `alumnet`.
   3. The photo files stayed on your laptop, so clear the links to them:
      ```
      USE alumnet;
      UPDATE users SET avatar_key = NULL;
      UPDATE events SET banner_key = NULL;
      UPDATE career_opportunities SET logo_key = NULL;
      DELETE FROM images;
      DELETE FROM app_settings WHERE setting_key LIKE 'brand_logo%';
      ```
   Starting empty instead: create the schema `alumnet` in Workbench, and after step 3 create the
   first admin from your laptop with the Aiven settings in the terminal:
   `node scripts/create-admin.js "Full Name" you@example.com <password>`.
5. Note the region you chose. The privacy notice says data may be kept outside Kenya, and the
   report should name the regions of Aiven, Hugging Face and Cloudflare.

## 2. The two Hugging Face Spaces

1. Sign up at huggingface.co. If your supervisor agrees, ask to join the Strathmore
   organisation (`SU-students-ai-321`) and create the Spaces there; otherwise use your own
   account, as the course guide allows.
2. Create two Spaces, both **Docker** (Blank), **CPU basic** (free), **Public**:
   `alumnet-api` and `alumnet-ml`. Leave them empty: GitHub fills them in step 4.
3. In **alumnet-ml → Settings → Variables and secrets**, add these **secrets**:

   | Name | Value |
   |---|---|
   | `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` | from Aiven (or the read-mostly user below) |
   | `DB_NAME` | `alumnet` |
   | `DB_SSL_CA` | the full text of `ca.pem`, including the BEGIN and END lines |
   | `ML_API_KEY` | your `ML_API_KEY` |
   | `MODEL_REVISION` | the commit id of the model release (see below) |

   The model revision: open huggingface.co/BAAI/bge-small-en-v1.5 → **Files and versions** →
   **History**, and copy the id of the newest commit. Record it in Chapter 5: the service loads
   exactly that release, and its `/health` page reports it.
4. In **alumnet-api → Settings → Variables and secrets**, add these **secrets**:

   | Name | Value |
   |---|---|
   | `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` | from Aiven |
   | `DB_NAME` | `alumnet` |
   | `DB_SSL` | `true` |
   | `DB_SSL_CA` | the full text of `ca.pem` |
   | `JWT_SECRET`, `TOTP_ENC_KEY` | as in "Before you start" |
   | `JWT_EXPIRES_IN` | `7d` |
   | `ML_SERVICE_URL` | `https://<username>-alumnet-ml.hf.space` |
   | `ML_API_KEY` | your `ML_API_KEY` |
   | `GATEWAY_SECRET` | your `GATEWAY_SECRET` |
   | `APP_URL` | your Cloudflare address from step 3, for example `https://alumnet.pages.dev` |
   | `MEDIA_DRIVER` | `db` (images are kept in the database: a Space's disk is wiped on restart) |
   | `BREVO_API_KEY`, `MAIL_FROM`, `MAIL_DEV_REDIRECT` | optional, see step 6 |

## 3. Pages and gateway on Cloudflare

1. Sign up at cloudflare.com (no card needed for Pages). **Workers & Pages → Create →
   Pages → Connect to Git**, and authorise only the AlumNet repository.
2. Settings:
   - Production branch: **main**
   - Framework preset: **None**
   - Build command: leave empty
   - Build output directory: `frontend/public`
   - Root directory: leave empty (the gateway in `functions/` is found from there)
3. Under **Settings → Variables and secrets** (Production), add `BACKEND_URL` =
   `https://<username>-alumnet-api.hf.space` and `GATEWAY_SECRET` (choose **Encrypt**). Then
   **Deployments → Retry deployment** so the function picks them up.
4. Note your address (for example `https://alumnet.pages.dev`) and put it in the API Space's
   `APP_URL` secret.

## 4. Connect GitHub to the Spaces

1. On Hugging Face: **Settings → Access Tokens → Create new token**, type **Write** (or a
   fine-grained token with write access to the two Spaces only).
2. On GitHub: **Settings → Secrets and variables → Actions**.
   - **Secrets:** `HF_TOKEN` = the token.
   - **Variables:** `HF_USERNAME` = your Hugging Face username (or the organisation's name).
3. Open **Actions → Deploy → Run workflow**. From now on, every push to `main` that passes CI is
   published to both Spaces automatically, labelled with its commit.
4. Each Space builds for about 10 minutes the first time. `alumnet-api` applies the database
   migrations when it starts.

## 5. Check the live release (and keep the evidence)

1. `https://<username>-alumnet-ml.hf.space/health` shows `"status": "ok"`, the model and its
   revision.
2. `https://<username>-alumnet-api.hf.space/api/config` shows *"Open AlumNet from its main
   address"*: the server refuses anything that skips the gateway.
3. On your Cloudflare address: sign in as mentee, mentor and admin (the admin needs two-factor).
   As a mentee open **Find a mentor**. As admin upload the logo in **Branding**.
4. Failure tests the guide asks for: pause the `alumnet-ml` Space (Settings → Pause) and search
   for a mentor (keyword search takes over); sign in, wait for the session to end and try again;
   send an image that is too large.
5. Record in Chapter 5: the three URLs, the commit shown on the Spaces, the model revision,
   regions, and screenshots of these tests.

## 6. Optional: Google sign-in and email

- **Google sign-in:** in Google Cloud Console → Credentials, add your Cloudflare address under
  **Authorised JavaScript origins**, and set `GOOGLE_CLIENT_ID` on the API Space.
- **Email:** Spaces cannot send over SMTP, so use Brevo's web API: sign up at brevo.com (free:
  300 emails a day), verify your Gmail as a sender, create an API key and set `BREVO_API_KEY`
  and `MAIL_FROM` on the API Space. `MAIL_DEV_REDIRECT` sends every email to your own inbox
  during the demo. Without email, reset links appear in the API Space's **Logs**.

## Limits of the free plans

- A free Space sleeps after 48 hours without visits and takes a minute or two to wake. Open
  the site, and **Find a mentor**, a few minutes before a demo.
- Cloudflare Pages Functions: 100,000 requests a day on the free plan; pages and images do not
  count, only `/api`, `/media`, `/brand` and `/health`.
- Aiven's free MySQL is small and has one node. Make your own backups (below).
- Every free offer can change. Record the plan and the date you checked it, and what you will
  do after assessment (keep or delete the Spaces, the Pages project and the Aiven service).

## Least privilege for the matching service

The matching service only needs to read profiles and write its own cache of
profile vectors. On a hosted database, give it its own user with just that:

```sql
CREATE USER 'alumnet_ml'@'%' IDENTIFIED BY 'a-long-random-password';
GRANT SELECT ON alumnet.users TO 'alumnet_ml'@'%';
GRANT SELECT ON alumnet.mentors TO 'alumnet_ml'@'%';
GRANT SELECT ON alumnet.profiles TO 'alumnet_ml'@'%';
GRANT SELECT ON alumnet.staff_directory TO 'alumnet_ml'@'%';
GRANT SELECT, INSERT, UPDATE ON alumnet.profile_embeddings TO 'alumnet_ml'@'%';
```

Use this user's details for `DB_USER` and `DB_PASSWORD` in the Hugging Face
Space. If the service is ever compromised, it cannot change accounts, posts
or reports.


## Admins and account recovery

- Create only the first admin with `node scripts/create-admin.js`. Add the others on the
  **Admins** page; once there are two admins, each further change needs the other to approve it.
- Every admin should be a person, not a shared account, so the activity log says who did what.
- When a member has lost their phone and backup codes, open them in **User management** and
  use **Reset two-factor**. Phone the number HR holds (shown there), never a number the caller
  gives. Write down what you checked; it goes in the activity log.

## Backups and restoring

Aiven's free plan keeps a single backup for its own disaster recovery, cannot restore to a
point in time and may power off a service that has been idle. So keep your own copies.

**Set up once.** Make a backup key the same way as `JWT_SECRET` (64 hexadecimal characters)
and put it in `backend/.env` as `BACKUP_KEY`. Store a second copy of the key in your password
manager, not next to the backups. Make a file `backend/.env.live` with the Aiven `DB_*`
settings and the same `BACKUP_KEY` (git ignores it as long as you never add it).

**Make a backup** (from the `backend` folder, at least weekly and before every migration):

```
npm run backup -- --env=.env.live
```

It writes an encrypted file such as `backups/alumnet-20261024-1500.sql.gz.enc`. Copy it to a
second place you control (for example a private OneDrive folder). Backups hold personal data,
so never commit them, email them or keep unencrypted copies.

**Prove it restores** (this is the test restore):

```
npm run restore-check
```

With no file named it checks the newest backup in `backups`. To check a particular one, add
its name: `npm run restore-check -- backups\alumnet-20261024-1500.sql.gz.enc`.

It loads the backup into a scratch database called `alumnet_restore_test` on your local MySQL,
checks that every table has the same number of rows and the same data as when the backup was
made, then deletes the scratch database. Keep the output (it states the number of tables and
rows and how long the restore took) as evidence for the report. CI runs the same check on the
test database on every push.

**Restore for real** (if the Aiven database is lost):

1. Create a new MySQL service on Aiven and put its settings in `backend/.env.live`.
2. Run `npm run restore-check -- <latest backup> --keep` with `RESTORE_DB_HOST`,
   `RESTORE_DB_PORT`, `RESTORE_DB_USER`, `RESTORE_DB_PASSWORD`, `RESTORE_DB_SSL=true` and
   `RESTORE_DB_SSL_CA` set to the new service in the terminal. It builds `alumnet_restore_test`
   there and checks it.
3. Point the API Space's `DB_NAME` (and host settings) at that database and restart it. Anything
   written after the backup was made is lost, which is why backups should be frequent.

## Photos and images

Profile photos, event banners, event photos, logos and report screenshots are redrawn as
WebP when they are uploaded and saved through `backend/src/utils/storage.js`.

- **On your laptop** nothing is needed: files go to `backend/uploads` (ignored by git).
- **On the Hugging Face Space** set `MEDIA_DRIVER=db`: a Space's disk is wiped whenever it
  restarts, so the WebP files are kept in the `media_files` table and are included in the
  database backups.
- **At larger scale** use a bucket: `MEDIA_DRIVER=s3` with Cloudflare R2 or Amazon S3
  (`S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`).
  Keep the bucket private: AlumNet serves every image and checks who may see it.
- At larger scale, put Cloudflare's CDN in front of `/media/*`: the images are already sent
  with long cache times and new addresses whenever one changes.

## Security settings to check after deploying

- `ML_API_KEY` must be set on Hugging Face. On a Space the service refuses to start without it
  (it detects the Space automatically), so a missing key shows up as a failed build, not an open
  service.
- `TOTP_ENC_KEY` must be set on the API Space before anyone turns on two-factor, and never changed.
- `GATEWAY_SECRET` must be the same on the API Space and in Cloudflare Pages. Without it on the
  Space, the server would accept requests that skip the gateway.
- Admin sessions end after 30 minutes without use, so expect to sign in again after a break.
