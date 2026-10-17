# Deploy guide — Ortho Practice Manager

This puts the app online for **free**, on the doctor's own Google account and a free GitHub account.
It takes about 45 minutes the first time. No bank card is needed.

What you will create:

| Part | Where | What it does |
|---|---|---|
| Apps Script project | script.google.com (doctor's Gmail) | The app's "brain": checks sign-in, rules, saves data |
| "Ortho DB" Google Sheet | Doctor's Google Drive (made automatically) | The data. **Never edit it by hand.** |
| "Ortho Backups" and "Ortho Excel" folders | Doctor's Google Drive (made automatically) | Hourly copies and daily Excel files |
| Google sign-in client ID | console.cloud.google.com | Lets people sign in with Google |
| GitHub Pages site | github.com (free account) | The installable app screens |

You need two files from the `dist` folder: `dist/apps-script/Code.gs` and `dist/apps-script/appsscript.json`, and the whole `dist/web` folder.

---

## Step 1 — Create the Apps Script project

1. Sign in to Chrome with the **doctor's Gmail**. Open <https://script.google.com> and click **New project**.
2. Click "Untitled project" at the top and rename it to **Ortho API**.
3. Delete everything in `Code.gs`. Open `dist/apps-script/Code.gs` in a text editor, copy all of it, and paste it in. Press **Ctrl+S**.
4. Click **Project Settings** (gear icon). Tick **Show "appsscript.json" manifest file in editor**.
5. Go back to **Editor**, open `appsscript.json`, replace its content with `dist/apps-script/appsscript.json`, and save.

## Step 2 — Create the Google sign-in client ID

1. Open <https://console.cloud.google.com> with the same Gmail. Create a new project named **Ortho**.
2. Go to **APIs & Services → OAuth consent screen**. Choose **External**. Fill in the app name ("Ortho Clinics"), the support email and the developer email. Save.
   - Add only the basic scopes: `openid`, `email`, `profile`. With only these, Google does not need to review the app.
   - Under **Audience / Test users**, add the doctor's Gmail and every assistant's Gmail. Or click **Publish app** so any Gmail you add inside the app can sign in.
3. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   - Application type: **Web application**. Name: "Ortho web".
   - **Authorized JavaScript origins**: add `https://YOUR-GITHUB-NAME.github.io` (no slash and no path at the end). You get this address in Step 5. You can come back and add it then.
   - Click **Create** and copy the **Client ID**. It ends with `.apps.googleusercontent.com`.

> You do **not** need to enable the Google Drive API in this project. Apps Script uses its own built-in Drive access.

## Step 3 — Give the script the client ID and run setup

1. In the Apps Script project, open **Project Settings → Script properties → Add script property**.
   - Property: `CLIENT_ID`. Value: the client ID from Step 2. Save.
2. Open the **Editor**. In the function list at the top, choose **setup**, then click **Run**.
3. Google asks for permission. Click **Review permissions**, choose the doctor's account, then **Advanced → Go to Ortho API (unsafe) → Allow**.
   The warning appears because this is your own private script, not a public app.
4. Wait until the log says **Setup done**. Check Google Drive: you should see **Ortho DB**, **Ortho Backups** (with one copy inside) and **Ortho Excel**.

## Step 4 — Publish the script as a web app

1. Click **Deploy → New deployment**. Click the gear and choose **Web app**.
2. Execute as: **Me**. Who has access: **Anyone**.
   ("Anyone" can reach the address, but every request is refused unless it carries a valid Google sign-in of a user listed in the app.)
3. Click **Deploy** and copy the **Web app URL**. It ends with `/exec`.

## Step 5 — Put the app on GitHub Pages

1. Create a free account at <https://github.com>. Your site address will be `https://YOUR-GITHUB-NAME.github.io`.
2. Click **New repository**. Name it `ortho`, choose **Public**, and create it.
   (Public is required for free Pages. The code contains no passwords and no patient data. Data stays in the doctor's Google Sheet.)
3. Click **uploading an existing file**. Drag **all files and the `icons` folder** from `dist/web`, then click **Commit changes**.
4. Open `config.js` in the repository and click the pencil icon to edit it:
   ```js
   API_URL: 'https://script.google.com/macros/s/....../exec',
   CLIENT_ID: '1234-abc.apps.googleusercontent.com',
   DEV: false
   ```
   Commit the change.
5. Go to **Settings → Pages**. Source: **Deploy from a branch**. Branch: **main**, folder **/ (root)**. Save.
   After 1–2 minutes the app is at `https://YOUR-GITHUB-NAME.github.io/ortho/`.
6. Go back to Step 2.3 and make sure `https://YOUR-GITHUB-NAME.github.io` is in **Authorized JavaScript origins**.

## Step 6 — First use

1. Open the app address in Chrome. Sign in with the **doctor's Gmail**. The doctor's account was made the owner in Step 3.
2. **Settings → Clinics → + clinic**: add each clinic. The default split is 70% doctor / 30% clinic. Choose the lab rule for each clinic.
3. **Settings → Users → + user**: add each assistant's Gmail, their clinics, and whether they may record payments.
4. Install on each phone: open the address in Chrome → menu (⋮) → **Install app** or **Add to Home screen**.

## Step 7 — Check that it really works (do this once)

- [ ] Add a test patient and a payment on one phone. Within about a minute it appears on a second phone.
- [ ] Turn on airplane mode, record a payment, close and reopen the app: it shows "في انتظار الإرسال". Turn airplane mode off: it changes to "تمت المزامنة".
- [ ] Sign in as an assistant: they see only their clinics and no Lab or Accounts tabs.
- [ ] After one hour: **Settings → Backups → Show backups** lists a new copy marked "ناجح".
- [ ] Next morning: the nightly check shows "ناجح", and **Ortho Excel** holds a new `.xlsx` file. Open it.
- [ ] Test a restore once: make a backup, add a test patient, restore the backup, and check that the test patient is gone. A "pre-restore" copy is kept.

Delete the test patient data before real use. In this version, patients are never deleted. Use a fresh setup instead: make a new Apps Script project, or remove the Script property `DB_ID` and run `setup` again to start a new, empty Sheet.

---

## Updating the app later

- **Screens** (files in `dist/web`): upload the new files to GitHub and **keep your edited `config.js`**. Phones pick up the new version the next time the app is opened.
- **Script** (`Code.gs`): paste the new code, then **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The `/exec` address stays the same.

## Troubleshooting

| Message or problem | Cause and fix |
|---|---|
| "انتهت جلسة الدخول" again and again | `CLIENT_ID` in the Script property and in `config.js` are different, or the site address is missing from Authorized JavaScript origins |
| "هذا الحساب غير مسموح له" | Add that Gmail in **Settings → Users** (and as a test user, if the consent screen is in Testing) |
| Google sign-in button does not appear | Check `CLIENT_ID` in `config.js`. Open the site by its `https://` address, not as a local file. |
| Excel export fails with 403 (shown in backup log and by email) | In `appsscript.json`, change `drive.file` to `https://www.googleapis.com/auth/drive`, save, run `setup` again and allow |
| "الخادم مشغول" | Many saves arrived at once. The app retries by itself. |

## Free limits (Google, for Gmail accounts)

Each request can run up to 6 minutes, triggers can run 90 minutes a day in total, and up to 30 requests can run at once per user ([Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)). A Google Sheet holds up to 10 million cells. This is enough for one doctor, a few assistants and many years of records. Each save takes about 1–3 seconds.

## Security checklist

- [ ] Turn on **2-Step Verification** on the doctor's Google account. That account owns all the data.
- [ ] Never share the "Ortho DB" Sheet with anyone. Assistants work only through the app.
- [ ] When an assistant leaves, untick **Active** in Settings → Users. Their next request is refused.
- [ ] On shared devices, set a **lock PIN** (Settings → This device), or sign out, which wipes the device copy.
