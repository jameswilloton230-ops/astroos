# NovaByte publisher portal deployment

The public catalog remains a GitHub Pages site. Supabase supplies email/password
accounts, private package uploads, owner-specific app lists, the public catalog
for approved community apps, and the server-only review/signing API.

## 1. Connect the static site

Set `supabaseUrl` and `supabaseAnonKey` in `src/publishing-config.js` to the
Supabase project's **Project URL** and **publishable/anon key**. Those two
values are public browser configuration. Never put a service-role key or a
signing private key in `src/`, a GitHub Pages artifact, or browser storage.

The administrator email is fixed to `dirazmuhammad400@gmail.com` in both the
site and Edge Function. Admin authorization is checked again by the server;
hiding the review button in the page is not the security boundary.

## 2. Create the database and buckets

From the repository root, link the Supabase CLI to the intended project and
apply the migration:

```powershell
supabase link --project-ref <project-ref>
supabase db push
```

The migration creates:

- A public-read-only `publisher_catalog_apps` catalog table, named separately
  to avoid collisions with existing project tables.
- Private ownership and submission tables protected by row-level security.
- A private `publisher-submissions` bucket with per-user upload paths.
- A public-read-only `published-packages` bucket. Only the Edge Function's
  service role can write published packages.

Do not weaken the RLS policies or expose the private submission bucket.
The follow-up migration adds server-generated automated review reports and an
`automated_rejected` status for packages that fail blocking checks.
The catalog-ratings migration adds public aggregate scores and written reviews
for NovaByte apps, Studio plugins, and community templates. Verified accounts
may keep one editable rating per catalog item; reviewer account IDs remain
private, and public review endpoints return only the rating, text, and date.
Apply it with `supabase db push` before enabling ratings in the site.

## 3. Configure account verification

In Supabase Authentication:

1. Enable email/password sign-up and **Confirm email**.
2. Set the site URL to `https://novabyteteam.github.io/novabyte-os/`.
3. Add `https://novabyteteam.github.io/novabyte-os/` to the allowed redirect
   URLs. Add local URLs only if you want to test account verification locally.
4. Configure a production SMTP provider so verification and account emails
   are delivered reliably.

The portal rejects publishing actions unless Supabase reports the account's
email as confirmed.

## 4. Configure private Edge Function secrets

Deploy the API:

```powershell
supabase functions deploy publisher-api --project-ref jcrptxtmieveoijdbtqa
```

The function disables Supabase's gateway-level JWT check so gateway errors
cannot bypass its CORS responses. The handler still validates every user's
bearer token with Supabase Auth and requires a confirmed email before allowing
publisher actions.

Set these values in the Supabase Dashboard's Edge Function secrets (or with
`supabase secrets set` from a secure terminal):

- `NOVABYTE_SIGNING_PRIVATE_JWK`: the Ed25519 private JWK whose public `x`
  value matches `Id_PakcUqjCM2k3i7mSkQy7LadrM_PwVz9S1ikYAzEY`, the
  `NovaByte Trusted Signing` public key already shipped by the site and OS.
  The function refuses to publish if the key is absent or does not match.
  Do not use the committed development/System key or expose this private key
  in the repository. If the matching trusted private key is unavailable,
  publishing must remain disabled until a deliberate trust-store key rotation
  is planned and deployed to the website and OS.
- `RESEND_API_KEY`: API key for the email provider used for submission and
  review notifications.
- `PUBLISHER_NOTIFICATION_FROM`: a sender address verified with that provider.
- `PUBLIC_CATALOG_URL`: `https://novabyteteam.github.io/novabyte-os/apps.json`.

Supabase supplies `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY` to Edge Functions. Confirm that the deployed
function has those environment values available; the service-role key must
only exist in the function environment.

## 5. Publish and review behavior

- Publishers sign up with email/password, verify their address, then submit
  listing details and a `.novaapp` package. The Edge Function runs automated
  package checks before creating a human-review queue item. Blocking findings
  are saved to the publisher's submission history as `automated_rejected`;
  passing packages remain private and enter the human-review queue.
- The authorized reviewer can download each pending package, inspect it,
  upload the reviewed `.novaapp`, and then approve, request changes, or reject.
  Approval is disabled until the reviewed package has been uploaded; the Edge
  Function signs that uploaded package with the trusted key during publication.
- Automated checks block malformed/unsafe package paths, missing manifest
  requirements or entry files, mismatched app identity/version, binary assets,
  dynamic code execution, remote script loading, and declared permissions
  without a matching `permissionReasons` entry (apps published before that
  requirement stay listed; it is enforced again on their next update). They
  also report network references, possible minification/obfuscation, and
  privileged permissions.
  Semantic requirements (such as whether data handling is appropriate) remain
  on the human-review checklist; a clean automated report is not an approval.
- Every submission, including submissions from the reviewer account, must pass
  automated checks and receive explicit human approval before publication.
- The reviewer inbox is available only to the verified
  `dirazmuhammad400@gmail.com` account. Other users cannot list, download, or
  change submissions, even if they manually call the Edge Function.
- The reviewer can dehost any community-published app from Review Apps.
  Dehosting removes the public catalog entry and deletes all package files for
  that app; the static built-in catalog is not affected.
- Approval validates the package ID/version, applies the reviewed listing
  metadata, recalculates SHA-512 file and payload integrity hashes, signs the
  package with the server-side Ed25519 key, and only then adds the release to
  the public catalog.
- Rejection and change requests notify the publisher. Publishers can withdraw
  their own submissions or remove their own published app from the catalog.
- Email notification delivery uses Resend. If its secrets are absent, Resend
  rejects the sender, or the request cannot reach Resend, the submission/review
  action remains complete. The portal reports which configuration or delivery
  issue needs attention; check the `publisher-api` Edge Function logs for
  provider details.

Before announcing the portal, test a new submission and an update using a
non-production app, verify the package signature from the live site and NBOSP,
and confirm the admin account can review while an ordinary verified account
cannot.

## Studio community starter templates

The `20261108000000_community_templates.sql` migration adds the public,
read-only `publisher_catalog_templates` table and private owner/submission
tables. It reuses the existing private `publisher-submissions` bucket and the
public-read, service-role-write `published-packages` bucket. Apply it with
`supabase db push` before deploying the updated `publisher-api` function.

Publishers submit one UTF-8 JSON file with this unsigned wrapper:

```json
{
  "format": "novapack-studio-user-template",
  "version": 1,
  "template": {
    "name": "Starter",
    "description": "A starter project template.",
    "author": "Publisher",
    "releaseVersion": "1.0.0",
    "category": "general",
    "icon": "✨",
    "manifest": {},
    "files": {
      "README.md": "Starter project contents"
    }
  }
}
```

The Publisher Portal accepts the unsigned `.nbtemplate` exported by Studio.
The original bundle is kept intact; the backend decodes Base64 file contents
only to validate that they are UTF-8 text and safe to publish. Files that are
not valid UTF-8 are rejected.

The backend never executes template contents. It rejects unknown
wrapper/template fields (including screenshots), prototype keys,
unsafe/hidden/`node_modules` paths, manifest filename collisions, duplicate
paths, binary file values, and metadata/version mismatches. Uploads are limited
to 4 MiB, 2 MiB expanded UTF-8 file content, and 500 files. Template
descriptions are limited to 240 characters, matching Studio's catalog
validator.

All template submissions require explicit human review. Reviewers must inspect
the entire submitted bundle, sign the exact template with NovaByte Trusted
Signing, then upload that signed `.nbtemplate` for approval. The upload may be
the UTF-8 JSON bundle or its Base64-encoded contents; the Store decodes a
Base64 upload before verifying it. The Store verifies the Ed25519 signature,
confirms the signed contents exactly match the original submission, and
publishes the verified JSON bundle without re-signing. Approval cannot proceed
without that signed review upload.
Publisher API actions are `submit-template`, `my-templates`,
`withdraw-template`, `template-review-list`, `upload-reviewed-template`, and
`review-template`. The Studio client reads the public catalog directly; no
additional browser-side signing key or publishing secret is needed.
