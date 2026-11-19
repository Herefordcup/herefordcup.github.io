# Hereford Cup email notification setup

This release sends through a dedicated free Gmail account by Google Apps Script. It does not require a Gmail app password or 2-Step Verification. Google currently limits consumer Apps Script accounts to 100 email recipients per day.

## Architecture

1. Migration `017_member_email_notifications.sql` creates member preferences, logical notification jobs, per-recipient delivery tracking, and database triggers. Migration `018_membership_approval.sql` changes the new-member trigger to queue an approval request when an ordinary account receives a pending membership.
2. Approval-request jobs resolve every current active tournament administrator when the worker claims the job. No administrator address is hard-coded.
3. Existing and future matches and itinerary activities receive reminder jobs scheduled 12 hours before `starts_at`.
4. Material schedule changes and cancellations enqueue immediate jobs.
5. The `process-notifications` Edge Function claims due deliveries with the service role and resolves each recipient address from Supabase Auth. Addresses are never stored in public notification tables or returned to the browser.
6. A one-minute Apps Script trigger securely claims messages, sends them with `MailApp`, and acknowledges each result.

## Required server configuration

Apply migrations `017_member_email_notifications.sql` and `018_membership_approval.sql`, in that order, before deploying browser assets that query notification preferences or use member approval controls.

Deploy `supabase/functions/process-notifications/index.ts` with JWT verification disabled. The function performs its own shared-secret authentication; `supabase/config.toml` records this setting.

Configure these Supabase Edge Function secrets without putting their values in source control, SQL, browser code, logs, or chat:

- `SUPABASE_SERVICE_ROLE_KEY`
- `NOTIFICATION_WORKER_SECRET` — a random value of at least 32 characters

`SUPABASE_URL` is supplied automatically by Supabase.

## Google Apps Script setup

1. While signed in to the dedicated sender Gmail account, create a standalone project at `https://script.google.com/` named `Hereford Cup Notifications`.
2. Replace the starter script with `google-apps-script/notification-worker.gs`.
3. In Project Settings → Script properties, add:
   - `SUPABASE_NOTIFICATION_FUNCTION_URL` = the deployed `process-notifications` function URL
   - `NOTIFICATION_WORKER_SECRET` = the same protected value configured in Supabase
4. Select `installNotificationTrigger` and click Run.
5. The Gmail account owner must personally review and approve Google's permission screen. The script needs permission to call the Edge Function and send Hereford Cup email.
6. Verify the Triggers page shows `runNotificationWorker` on a one-minute time trigger.

Do not deploy the script as a public web app. It runs only as an owner-authorized time trigger.

## Controlled production test

Do not test by emailing the roster. In the Supabase SQL editor:

1. Insert one `notification_jobs` row with `status = 'expanded'` and a unique test idempotency key.
2. Insert one `notification_deliveries` row for the designated administrator's existing Supabase user ID.
3. Run `runNotificationWorker` once from Apps Script.
4. Verify exactly one Gmail message arrived at the controlled recipient.
5. Read back the exact delivery row and confirm `status = 'sent'`, `attempt_count = 1`, `sent_at is not null`, and `last_error is null`.
6. Delete only the controlled test job; its delivery cascades. Never delete live delivery history.

Then validate one job of each type in a non-roster test path: new member, reminder boundary, schedule change, and cancellation. Confirm idempotency by rerunning the worker and observing no duplicate email.

## Operational behavior

- Missing preference rows default to all email categories enabled.
- Members can change settings under Portal → More → Notifications.
- New-member alerts apply only to active tournament administrators.
- Reminder and schedule messages apply only to active tournament members.
- Failed sends retry with backoff up to five attempts.
- Processing claims become retryable after 15 minutes.
- Apps Script remembers recently sent delivery IDs before acknowledgement to reduce duplicates if acknowledgement fails.
- If the Gmail daily quota is exhausted, the worker claims nothing until quota is available again.

To stop sending immediately, delete the Apps Script time trigger or run `removeNotificationTrigger`. This leaves queued jobs and delivery history intact.
