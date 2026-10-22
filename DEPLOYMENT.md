# Deploying AlumNet

AlumNet runs online on three free services:

| Part | Host | Why |
|---|---|---|
| Database | Aiven for MySQL (free plan) | Managed MySQL 8 with encrypted connections |
| ML service | Hugging Face Spaces (Docker, free CPU) | 16 GB of memory, enough for PyTorch and the model |
| Backend and frontend | Render (free web service) | Runs the Node server, which also serves the pages |

Do the steps in this order: each one needs details from the one before. Keep a private note
of every password and key as you go. Never put them in the repository.

## Before you start

Generate two random secrets. In PowerShell, run this twice and keep both results:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The first is your `JWT_SECRET`; the second is your `ML_API_KEY`.

## 1. Database on Aiven

1. Sign up at aiven.io and create a service: **MySQL**, **Free plan**.
2. When it is running, open the service's **Overview** and note the **Host**, **Port**,
   **User** (`avnadmin`) and **Password**. Download the **CA certificate** (`ca.pem`).
3. In MySQL Workbench, add a connection to Aiven with that host, port, user and password.
   On the **SSL** tab set *Use SSL* to **Require and Verify CA** and choose `ca.pem` as the
   *SSL CA File*. Test the connection.
4. Copy your local data across:
   1. Connect to your **local** database. Choose **Server → Data Export**, tick `alumnet`,
      select **Dump Structure and Data** and **Export to Self-Contained File**.
      Under **Advanced Options**, set **set-gtid-purged** to **OFF**. Start the export.
   2. Connect to **Aiven**. Choose **Server → Data Import**, pick the file, set
      **Default Target Schema** to a new schema called `alumnet`, and start the import.
5. Check that the tables and demo accounts are there.

## 2. ML service on Hugging Face Spaces

1. Sign up at huggingface.co. Choose **New → Space**.
   - Name: `alumnet-ml`
   - SDK: **Docker** (Blank template)
   - Hardware: **CPU basic** (free)
   - Visibility: **Public**. The service still refuses requests without your `ML_API_KEY`.
2. In the Space, open **Files → Add file → Upload files** and upload these three files from
   the `ml-service` folder: `Dockerfile`, `app.py` and `requirements-deploy.txt`. Commit.
3. Open **Settings → Variables and secrets** and add these as **secrets**:

   | Name | Value |
   |---|---|
   | `DB_HOST` | Aiven host |
   | `DB_PORT` | Aiven port |
   | `DB_USER` | `avnadmin` |
   | `DB_PASSWORD` | Aiven password |
   | `DB_NAME` | `alumnet` |
   | `DB_SSL_CA` | the full text of `ca.pem`, including the BEGIN and END lines |
   | `ML_API_KEY` | your second secret |

4. The Space builds for about 10 minutes. When it shows **Running**, open
   `https://<your-username>-alumnet-ml.hf.space/health`. It should show `{"status":"ok"}`.

## 3. Backend and frontend on Render

1. Run `npm install` in `backend` on your computer first, then commit and push. This updates
   `package-lock.json` with the new packages, which Render needs.
2. Sign in at render.com with GitHub. Choose **New → Web Service** and pick the AlumNet
   repository.
   - Root directory: leave empty
   - Runtime: **Node**
   - Build command: `cd backend && npm install`
   - Start command: `cd backend && npm start`
   - Instance type: **Free**
   - Health check path (under Advanced): `/health`
3. Add these environment variables:

   | Name | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `APP_URL` | your Render address, for example `https://alumnet.onrender.com` |
   | `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` | from Aiven |
   | `DB_NAME` | `alumnet` |
   | `DB_SSL` | `true` |
   | `DB_SSL_CA` | the full text of `ca.pem` |
   | `JWT_SECRET` | your first secret |
   | `JWT_EXPIRES_IN` | `7d` |
   | `ML_SERVICE_URL` | `https://<your-username>-alumnet-ml.hf.space` |
   | `ML_API_KEY` | your second secret |
   | `GOOGLE_CLIENT_ID` | your Google OAuth client ID |
   | `BREVO_API_KEY` and `MAIL_FROM` | see step 5 |
   | `MAIL_DEV_REDIRECT` | your own email address |

4. Create the service. The first deploy takes a few minutes. Open your Render address: you
   should see the AlumNet login page.

## 4. Allow Google sign-in on the live site

In Google Cloud Console, open **APIs & Services → Credentials**, edit your OAuth client and
add your Render address (for example `https://alumnet.onrender.com`) under **Authorised
JavaScript origins**. Keep `http://localhost:4000` for local use.

While the consent screen is in **Testing**, only the test users you added can sign in. Add
each Google account you will demo with, or choose **Publish app**. The app only asks for
name, email and profile, so publishing needs no Google review.

## 5. Email on the live site

Render's free plan blocks outgoing email over SMTP, so the live site sends email through
Brevo's web API instead:

1. Sign up at brevo.com (free: 300 emails a day).
2. Under **Senders, domains and dedicated IPs → Senders**, add your Gmail address and
   verify it.
3. Under **SMTP & API → API keys**, create a key.
4. In Render, set `BREVO_API_KEY` to the key and `MAIL_FROM` to the verified Gmail address.

If email is not set up, reset links appear in Render's **Logs** tab instead.

## 6. Check the live site

1. Log in as each demo account, by email and by username.
2. As a mentee, open **Find a mentor**. The first request after the Space has been idle can
   take up to a minute.
3. Use **Forgot password** and confirm the email arrives in your `MAIL_DEV_REDIRECT` inbox.
4. Turn on two-factor in **Account settings**, log out and back in with a code.
5. Sign in with Google using an account whose email matches, or one you linked in settings.

## Before a demo

Free services sleep when idle: Render after 15 minutes, Hugging Face after 48 hours. Open
the site and load **Find a mentor** once, a few minutes before you present.
