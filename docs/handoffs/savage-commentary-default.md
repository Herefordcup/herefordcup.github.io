# Savage commentary default

## Scope

Adds a fourth AI commentary tone, `savage`, above Ruthless. Savage keeps the existing deterministic safety model: the AI sees only an anonymous outcome class and may select only a server-owned phrase identifier. Player names, the exact result, and the turning point remain composed from authoritative score data inside `create_commentary_draft`.

## Behavior

- Admin tone choices: Clean, Playful, Ruthless, Savage.
- Savage is selected for unsaved/new commentary settings.
- Database default for new `commentary_settings` rows is `savage`.
- Existing saved tournament tone choices are preserved.
- Savage has six decisive-result phrases and two halved-result phrases.
- Phrases roast only scorecard performance and never invent shots, weather, injuries, motives, or personal facts.

## Database and deployment

Migration `036_savage_commentary_default.sql` must deploy before the updated Admin asset and Edge Function. It:

1. Extends `commentary_settings_tone_check` to admit `savage`.
2. Sets the column default to `savage` without updating existing rows.
3. Replaces `create_commentary_draft` with the current migration-024 implementation plus the Savage server-side phrase mapping.

The protected production workflow enforces migration-before-function-before-frontend ordering and exact remote migration-history verification. After migration 036 is verified remotely, it deploys `generate-match-commentary`; a failed function deployment blocks the Pages build.

The protected `production` environment's scoped `SUPABASE_ACCESS_TOKEN` must include `edge_functions_write`, `edge_functions_read`, `projects_read`, and production-branch read access in addition to its existing database/migration permissions. The currently stored token was originally created without Edge Function permissions, so rotate it before merging this PR; never place its value in chat, logs, commits, or screenshots.

## Verification

- `npm test` — 275/275 passing.
- `npx --yes deno check supabase/functions/generate-match-commentary/index.ts` — passed.
- `node C:/Users/pimen/AppData/Local/hermes/cache/scratch/hereford-migration-036.mjs` — applies migration 036 twice and verifies the constraint, default, preservation of existing settings, invalid-value rejection, and deployed function definition.
- Local browser QA at `admin.html?qa=savage-commentary-1` — Savage is selected, the Admin panel has no clipping/overlap, and the console is clean.

## Remaining production check

After approval and merge, watch the exact merge-SHA production workflow. Require migration 036 push and exact history verification to succeed before treating the Admin and Edge Function deployment as live. Then verify the production Admin HTML/JS and Edge Function assets. An authenticated administrator should confirm the saved current-tournament tone separately; migration 036 intentionally does not overwrite that saved choice.

## Hermes continuation

```text
git fetch origin
git checkout feat/savage-commentary-default
npm test
npx --yes deno check supabase/functions/generate-match-commentary/index.ts
node C:/Users/pimen/AppData/Local/hermes/cache/scratch/hereford-migration-036.mjs
```

No credentials or secret values are required for local verification.
