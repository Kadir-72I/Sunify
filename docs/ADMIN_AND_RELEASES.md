# Sunify admin panel and releases setup

The admin panel is intentionally hidden unless the active Sunify profile uses
`abdulkadirguness72@gmail.com`. Unlocking it also requires a
confirmed Supabase Auth account for that address, its Supabase password, and
the PIN stored as a Supabase Edge Function secret. The PIN and Supabase
service-role key are not included in the desktop application.

## Supabase setup

1. Create or invite `abdulkadirguness72@gmail.com` under Supabase
   Dashboard → Authentication → Users, then verify that address. The local
   Sunify profile by itself is not enough for admin access.
2. In Windows PowerShell, move to the Sunify project folder. Use `npx.cmd`
   (PowerShell may block the `npx.ps1` wrapper), sign in, then link the project:

   ```powershell
   cd "$env:USERPROFILE\Documents\Sunify"
   npx.cmd supabase login
   npx.cmd supabase link --project-ref wkphoyochjczmqdmuazo
   ```

3. Create a fine-grained GitHub token for the Sunify repository with **Actions:
   Read and write** and **Contents: Read** permissions. The workflow itself
   uses GitHub's short-lived `GITHUB_TOKEN` with Contents write permission to
   create releases and upload the Windows installer.
4. Store secrets in Supabase, not in the app source or renderer:

   In PowerShell, enter the PIN already chosen for Sunify and the fine-grained
   GitHub token at the masked prompts. Do not type the placeholder words
   literally:

   ```powershell
   $pinSecure = Read-Host -Prompt "Existing SUNIFY_ADMIN_PIN" -AsSecureString
   $tokenSecure = Read-Host -Prompt "GitHub fine-grained token" -AsSecureString
   $pin = [System.Net.NetworkCredential]::new("", $pinSecure).Password
   $token = [System.Net.NetworkCredential]::new("", $tokenSecure).Password
   npx.cmd supabase secrets set "SUNIFY_ADMIN_PIN=$pin" "SUNIFY_GITHUB_REPOSITORY=Kadir-72I/Sunify" "SUNIFY_GITHUB_TOKEN=$token" "SUNIFY_GITHUB_REF=main"
   Remove-Variable pin, token, pinSecure, tokenSecure
   ```

   `SUPABASE_SERVICE_ROLE_KEY` is provided to the Edge Function by Supabase.
   Never paste it into `data/supabase_config.json` or the desktop client.
5. Deploy the function:

   ```powershell
   npx.cmd supabase functions deploy sunify-admin --project-ref wkphoyochjczmqdmuazo
   ```

In the Supabase Dashboard's Edge Function secrets, set `SUNIFY_ADMIN_PIN` to
the owner-selected PIN (use the value already chosen for this panel); keep it
in the secret store, never in source or repository documentation.
The Edge Function validates Supabase Auth, checks the exact admin email and
PIN, and uses the service-role key only on the server. It can list users, show
their cloud playlists and analytics, clear those data, delete accounts, and
dispatch the release workflow.

## GitHub Releases

The admin release form starts the `.github/workflows/release.yml` workflow.
GitHub Actions builds a Windows NSIS installer, then publishes
`Sunify-Setup-<version>.exe`. The installer is downloaded from the
**Settings → About** update control. Sunify checks for a new release shortly
after launch and shows an in-app notification when one is available.

Public repositories are checked directly through GitHub. For a private
repository, the deployed `sunify-admin` Edge Function reads release metadata
and generates a short lived GitHub asset download redirect. The GitHub token
stays in Supabase and is never packaged in Sunify. The private update flow
requires the current Edge Function code to be deployed after updating it.

To publish a release from the app:

1. Push the finished changes to the `main` branch.
2. Open Sunify Settings → Admin Panel and sign in with the verified owner
   account, its normal Sunify/Supabase Auth password, and the
   `SUNIFY_ADMIN_PIN` secret value.
3. Enter a new SemVer such as `1.0.1` and release notes, then choose **Sürümü
   yayımla**. Follow the GitHub repository's Actions page until the workflow
   completes; the release then appears in Releases and is available in About.

## Data storage

Packaged installs store local accounts and Supabase settings in Electron's
per-user application data directory. The developer's `data/sunify_users.json`
and local logs are excluded from the published installer.
