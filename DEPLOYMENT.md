# Deploying AlumNet

AlumNet is deployed on free and student plans, following the course's Sprint III deployment
guide: **Cloudflare** for the public address and gateway (Example 1) and **Azure Container
Apps** for the server and the model, paid for by **Azure for Students** credit (the alternative
the guide names under "Plan credits around the chosen host").

```
Browser ──HTTPS──▶ Cloudflare Pages ──(gateway secret)──▶ Azure Container App: alumnet-api
                    pages + gateway                          Node/Express server
                    function                                  │               │
                                                              │ internal only │ TLS
                                                              │ + ML_API_KEY  │
                                                              ▼               ▼
                                             Azure Container App:      Aiven MySQL
                                             alumnet-ml (BGE model)    (managed database)
```

| Part | Host | Where it is in the course guide |
|---|---|---|
| Pages and gateway | Cloudflare Pages, deployed from GitHub `main` | Example 1, steps 3 to 6 |
| Server (Express API) | Azure Container App `alumnet-api` | "Azure credit, which may support an alternative deployment agreed with your supervisor" |
| Matching model | Azure Container App `alumnet-ml`, pinned model revision, no public address | Same; model loaded from the Hugging Face Hub at a fixed revision (Example 3) |
| Database | Aiven for MySQL, free plan | Example 2: "an appropriate managed database" |
| Releases | GitHub Actions: tests, then build both containers, labelled with the commit | Example 3: a sync workflow from GitHub `main` |

**Why this combination.** Cloudflare Pages serves static pages and small functions, so it
cannot run the Express server and its MySQL connection, and a free Worker allows only 10 ms of
processing per request, too little for password checks. Hugging Face Docker Spaces stopped
being free in July 2026, and the AWS route (Example 2) uses billable resources. Azure for
Students gives $100 of credit with no card, and Container Apps has a free monthly allowance
(180,000 vCPU-seconds and 2 million requests) and can scale to zero, so a demo deployment costs
nothing or very little of the credit. None of the course examples hosts MySQL, so the database
is on Aiven's free plan, with an encrypted connection. Agree this route with the supervisor.

**Why the gateway is a Pages Function, not a separate Worker.** Example 1 puts the gateway on
its own `api.` subdomain of a custom domain. AlumNet's sign-in uses a first-party cookie on the
same address as the pages, and there is no paid domain yet, so the gateway runs as a Pages
Function (a Cloudflare Worker that Pages deploys with the site) on the same address. If you
later register the free Namecheap `.me` domain from the GitHub Student Pack, attach it in
Pages → Custom domains (Example 1, steps 1, 2 and 5); nothing else changes.

Do the steps in order: each one needs details from the one before. Keep a private note of
every password and key. Never put them in the repository.

## Before you start

From your local `backend\.env`, copy `JWT_SECRET` and `TOTP_ENC_KEY` into your private notes.
The Azure setup script asks for them, and reusing them keeps two-factor working for the
accounts you copy across. It makes `ML_API_KEY` and `GATEWAY_SECRET` itself. Never change
`TOTP_ENC_KEY` after people turn on two-factor. If you start with an empty database, make
the two values with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 1. Database on Aiven

1. Sign up at aiven.io (no card needed) and create a service: **MySQL**, **Free plan**.
2. When it is running, note the **Host**, **Port**, **User** (`avnadmin`) and **Password**, and
   download the **CA certificate** (`ca.pem`).
3. In MySQL Workbench, add a connection to Aiven with those details. On the **SSL** tab set
   *Use SSL* to **Require and Verify CA** and choose `ca.pem`. Test the connection.
4. Either start empty (the server creates every table itself on first start), or copy your
   local data:
   1. Connect to your **local** database. **Server → Data Export**, tick `alumnet`, choose
      **Dump Structure and Data** and **Export to Self-Contained File**, and tick
      **Include Create Schema**. Under **Advanced Options**, set **set-gtid-purged** to **OFF**.
   2. Connect to **Aiven**. **Server → Data Import**, pick the file and set the
      **Default Target Schema** to a new schema called `alumnet`. Click **Start Import**.
   3. The photo files stayed on your laptop, so clear the links to them:
      ```
      USE alumnet;
      SET SQL_SAFE_UPDATES = 0;
      UPDATE users SET avatar_key = NULL;
      UPDATE events SET banner_key = NULL;
      UPDATE career_opportunities SET logo_key = NULL;
      DELETE FROM images;
      DELETE FROM app_settings WHERE setting_key LIKE 'brand_logo%';
      SET SQL_SAFE_UPDATES = 1;
      ```
   If the import fails with *"Unable to create or change a table without a primary key"*, set
   `sql_require_primary_key` to off in Aiven → Service settings → Advanced configuration.
   Starting empty instead: create the schema `alumnet` in Workbench, and after step 3 create the
   first admin from your laptop with the Aiven settings in the terminal:
   `node scripts/create-admin.js "Full Name" you@example.com <password>`.
5. The free plan powers the service off after a long period without use. If the site stops
   working, check that it is running in the Aiven console. Note the region for the report.

## 2. Publish the two containers from GitHub

1. Get the model revision: open huggingface.co/BAAI/bge-small-en-v1.5 → **Files and
   versions** → **History**, and copy the id of the newest commit. Record it in Chapter 5.
2. On GitHub: **Settings → Secrets and variables → Actions → Variables → New repository
   variable**: `MODEL_REVISION` = that id. The matching service is built with exactly that
   release of the model and loads the same one when it runs.
3. **Actions → Deploy → Run workflow**. It builds `alumnet-api` and `alumnet-ml` (about 10
   minutes the first time) and stores them in GitHub's container registry, labelled with the
   commit. From now on this happens after every push to `main` that passes CI.
4. Make the two images public so Azure can fetch them: on your GitHub profile open
   **Packages**, then for each of `alumnet-api` and `alumnet-ml`: **Package settings → Change
   visibility → Public**. They contain no secrets: `.env` files are never copied in.

## 3. The two Container Apps on Azure

1. Go to azure.microsoft.com/free/students, choose **Start free** and verify with your
   Strathmore email. No card is needed.
2. In the Azure portal, open **Cloud Shell** (the `>_` icon at the top), choose **Bash** and
   **No storage account required**.
3. Use **Manage files → Upload** to upload `ca.pem` and `deploy/azure/setup.sh` from your
   AlumNet folder, then run:
   ```
   bash setup.sh
   ```
   It asks for the Aiven details, `JWT_SECRET` and `TOTP_ENC_KEY` (typed without being shown),
   and creates:
   - `alumnet-ml`: 1 vCPU and 2 GiB, **internal only**, so it has no public address at all and
     only `alumnet-api` can reach it, still with `ML_API_KEY`.
   - `alumnet-api`: 0.5 vCPU and 1 GiB, public HTTPS address, refusing anything without the
     gateway secret. It applies the database migrations when it starts.
   Both scale to zero when nobody is using them, which keeps them inside the free allowance.
   Every password and key is stored as a Container Apps secret, not a plain setting.
4. If Azure refuses the region (*"RequestDisallowedByPolicy"*), run it again and choose one of
   the regions your subscription allows (shown in the error), ideally near your Aiven region.
5. Copy the two values it prints at the end, `BACKEND_URL` and `GATEWAY_SECRET`, into your
   private notes.

**Later releases.** Each Deploy run page shows two `az containerapp update` commands. Paste
them into Cloud Shell to switch the live site to that release. To make this automatic, add a
secret `AZURE_CREDENTIALS` (from `az ad sp create-for-rbac --role contributor --scopes
/subscriptions/<id>/resourceGroups/alumnet --json-auth`) and a variable `AZURE_RESOURCE_GROUP`
= `alumnet` on GitHub; student subscriptions sometimes do not allow this, and the commands
work either way.

## 4. Pages and gateway on Cloudflare

1. Sign up at cloudflare.com (no card needed for Pages). **Workers & Pages → Create →
   Pages → Connect to Git**, and authorise only the AlumNet repository.
2. Settings:
   - Project name: `alumnet` (your address becomes `https://alumnet.pages.dev`; if the name
     is taken, use the address Cloudflare gives you and update `APP_URL`, below)
   - Production branch: **main**
   - Framework preset: **None**
   - Build command: leave empty
   - Build output directory: `frontend/public`
   - Root directory: leave empty (the gateway in `functions/` is found from there)
3. Open **Environment variables (advanced)** and add `BACKEND_URL` and `GATEWAY_SECRET` from
   step 3 (choose **Encrypt** for the secret). **Save and Deploy**.
4. If your address is not `https://alumnet.pages.dev`, update the server in Cloud Shell:
   `az containerapp update -n alumnet-api -g alumnet --set-env-vars APP_URL=https://<your address>`

## 5. Check the live release (and keep the evidence)

1. `https://<alumnet-api address>/api/config` shows *"Open AlumNet from its main address"*:
   the server refuses anything that skips the gateway. `alumnet-ml` has no public address to
   test, which is the point.
2. On your Cloudflare address: sign in as mentee, mentor and admin (the admin needs two-factor).
   As a mentee open **Find a mentor**. As admin upload the logo in **Branding**.
3. Failure tests the guide asks for: stop `alumnet-ml` (portal → alumnet-ml → **Stop**) and search for a mentor (keyword search takes over), then
   start it again; sign in, wait for the session to end and try again; send an image that is
   too large.
4. Release evidence: `az containerapp show -n alumnet-api -g alumnet --query
   "properties.template.containers[0].image" -o tsv` shows the image and commit that is live;
   the Deploy run page shows the same commit and the model revision.
5. Record in Chapter 5: the Cloudflare address, the commit, the model revision, the Azure and
   Aiven regions, the date, and screenshots of these tests.

## 6. Optional: Google sign-in and email

- **Google sign-in:** in Google Cloud Console → Credentials, add your Cloudflare address under
  **Authorised JavaScript origins**, and set `GOOGLE_CLIENT_ID` on `alumnet-api`
  (`az containerapp update ... --set-env-vars GOOGLE_CLIENT_ID=...`).
- **Email:** use Brevo's web API: sign up at brevo.com (free: 300 emails a day), verify your
  Gmail as a sender, create an API key and add it as a secret on `alumnet-api`
  (`az containerapp secret set ... --secrets brevo-key=<key>`, then
  `--set-env-vars BREVO_API_KEY=secretref:brevo-key MAIL_FROM=<your email>`).
  `MAIL_DEV_REDIRECT` sends every email to your own inbox during the demo. Without email,
  reset links appear in `alumnet-api`'s **Log stream**.

## Limits of the free plans

- Both containers scale to zero. The first visit after a quiet period waits about 10 seconds
  for the server and up to a minute for the matching service (search uses keywords until it is
  ready). Open the site, and **Find a mentor**, a few minutes before a demo.
- Container Apps beyond the free allowance is charged to the $100 student credit. When the
  credit is used up the subscription is disabled, not charged to a card. Check **Cost
  Management** in the portal before and after a demo.
- Cloudflare Pages Functions: 100,000 requests a day on the free plan; pages and images do not
  count, only `/api`, `/media`, `/brand` and `/health`.
- Aiven's free MySQL is small, has one node and powers off when unused for a long time. Make
  your own backups (below).
- Every free offer can change. Record the plan and the date you checked it, and what you will
  do after assessment (keep or delete the Container Apps, the Pages project and the Aiven
  service).

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

Use this user's details for `DB_USER` and `DB_PASSWORD` on `alumnet-ml`. If the service is ever compromised, it cannot change accounts, posts
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
3. Point `alumnet-api`'s `DB_NAME` (and host settings) at that database and restart it. Anything
   written after the backup was made is lost, which is why backups should be frequent.

## Photos and images

Profile photos, event banners, event photos, logos and report screenshots are redrawn as
WebP when they are uploaded and saved through `backend/src/utils/storage.js`.

- **On your laptop** nothing is needed: files go to `backend/uploads` (ignored by git).
- **On Azure Container Apps** set `MEDIA_DRIVER=db` (the setup script does): a container's disk is
  wiped whenever it restarts, so the WebP files are kept in the `media_files` table and are included in the
  database backups.
- **At larger scale** use a bucket: `MEDIA_DRIVER=s3` with Cloudflare R2 or Amazon S3
  (`S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`).
  Keep the bucket private: AlumNet serves every image and checks who may see it.
- At larger scale, put Cloudflare's CDN in front of `/media/*`: the images are already sent
  with long cache times and new addresses whenever one changes.

## Security settings to check after deploying

- `ML_API_KEY` must be set on `alumnet-ml`. Its image sets `ML_REQUIRE_KEY=1`, so the service
  refuses to start without the key, and a missing key shows up as a failed start, not an open
  service. It also has no public address (internal ingress).
- `TOTP_ENC_KEY` must be set on `alumnet-api` before anyone turns on two-factor, and never changed.
- `GATEWAY_SECRET` must be the same on `alumnet-api` and in Cloudflare Pages. Without it on the
  server, the server would accept requests that skip the gateway.
- Admin sessions end after 30 minutes without use, so expect to sign in again after a break.
