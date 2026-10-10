# Site theLaunch — Static Hosting Platform Starter

This is a working **development MVP** for a GitHub Pages-style platform dashboard. It includes account registration/login, a project dashboard, ZIP upload records, GitHub/GitLab repository records, project search, and project deletion.

## Important: what this version does and does not do

**Works now**
- Creates accounts and signs users in/out.
- Hashes passwords using bcrypt.
- Stores users, projects, and sessions in SQLite.
- Allows a signed-in user to upload a ZIP archive up to 10 MB.
- Saves HTTPS GitHub/GitLab repository URLs.
- Keeps each user's project list private behind authentication.

**Not yet implemented**
- It does not deploy ZIP uploads to a public URL.
- Saving a Git URL does not connect or authorize the repository with a hosting provider.
- It does not run user-supplied build scripts or serve uploaded HTML.
- It is a starter for development, not a production-ready multi-tenant hosting service.

For public publishing, the next step is to connect a provider's supported API/CLI or have users connect Git repositories directly to a provider. Cloudflare Pages supports Git-based deployments and direct uploads; see the official docs below.

## Requirements

- Node.js 20 or newer
- Visual Studio Code
- Internet access for installing npm packages

Install Node.js from https://nodejs.org/ and then restart VS Code.

## Run in VS Code

1. Extract the `site-thelaunch.zip` folder.
2. In VS Code choose **File → Open Folder** and open `site-thelaunch`.
3. Open **Terminal → New Terminal**.
4. Run:

   ```bash
   npm install
   ```

5. Copy `.env.example` to a new file named `.env`.
6. In `.env`, replace `SESSION_SECRET` with a long, random secret. Keep `.env` private; never commit it to Git.
7. Start the server:

   ```bash
   npm start
   ```

8. Open http://localhost:3000 in your browser.
9. Select **Create account**, register, then create a project using a ZIP or a Git repository URL.

For development with automatic server restart:

```bash
npm run dev
```

## Make a test ZIP

Create a folder with an `index.html` file and any CSS or JavaScript files. Zip the *contents* of the folder so `index.html` is at the ZIP's top level. In the dashboard, create a project and upload that ZIP.

The current MVP stores the ZIP privately; it does not publish or execute its contents.

## Publish the dashboard itself

You can deploy the dashboard application to a Node.js-capable host. A static-only host cannot run `server.js`, SQLite, sessions, or account APIs. Configure these before a public deployment:

- `NODE_ENV=production`
- A strong `SESSION_SECRET`
- HTTPS and secure cookies
- Persistent disk/volume for SQLite and uploaded files, or move these to managed database/object storage
- Provider API credentials stored as server-side secrets (never in browser JavaScript)
- Request limits, upload scanning, abuse reporting, backups, monitoring, and isolated delivery domains for user websites

Do not use the default development session secret in public deployment. Do not expose the upload folder as a public static directory.

## Connect actual publishing

### Git repository route
Cloudflare Pages can connect GitHub/GitLab repositories and deploy on pushes. In Cloudflare's dashboard, create a Pages project, choose **Connect to Git**, authorize the repository, and select the build settings. Saving a repository in this MVP does not perform those authorization steps automatically.

### ZIP upload route
A production implementation needs a server-side publishing adapter that validates the archive, rejects path traversal/symlinks and disallowed files, extracts it into an isolated workspace, validates that `index.html` exists, and deploys the static assets using the provider's supported upload method. Do not extract arbitrary ZIP files directly into the app directory or execute customer build commands on the main server.

Official docs:
- Cloudflare Pages overview: https://developers.cloudflare.com/pages/get-started/
- Git integration: https://developers.cloudflare.com/pages/configuration/git-integration/
- Direct Upload: https://developers.cloudflare.com/pages/get-started/direct-upload/

## Main files

- `server.js` — Express API, SQLite database, sessions, upload handling
- `public/index.html` — account and dashboard layout
- `public/styles.css` — responsive styling
- `public/app.js` — front-end behavior
- `.env.example` — configuration template
