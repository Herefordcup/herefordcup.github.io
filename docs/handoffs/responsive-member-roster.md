# Responsive Active Members roster handoff

## Scope

This change replaces the growing Active Members column on `admin.html` with a bounded, responsive roster:

- Desktop: three member cards per row.
- Tablet: two member cards per row.
- Phone: one member card per row.
- The active roster uses a 600px internal scroll region so additional members do not lengthen the full Admin page.
- Pending approvals remain above the active roster in a compact, separately bounded section.
- The toolbar shows the visible/total member count and supports name, tournament-team, and tournament-role filtering.
- Active members remain alphabetically sorted.

## Preserved behavior

Each member card still provides:

- Automatic tournament-role saving.
- Automatic tournament-team saving.
- Handicap editing and explicit handicap saving.
- Membership deletion protections and controls.
- Existing mutation gating, authoritative response handling, rollback behavior, planner-option refresh, and server-side safeguards.

Filters toggle existing cards rather than rebuilding the roster. This preserves unsaved handicap input while an administrator searches or changes filters. A successful team save reapplies the active filter and member count immediately.

## Files

- `admin.html`
- `admin.css`
- `src/admin.js`
- `src/admin-helpers.js`
- `test/admin-planning.test.js`
- `test/member-approval.test.js`
- Cache-token assertions in commentary and Legacy tests

## Verification

- `npm test`: 276/276 passing.
- `git diff --check`: passing.
- Added-line security scan: no matches.
- Desktop QA at 1264px: three columns, 600px internal scroll, no horizontal overflow.
- Mobile QA at 390x844: one column, stacked filters, complete member controls, no horizontal overflow.
- Independent review: passed with no security concerns or logic errors after two filter-state issues were corrected.

## Deployment

No database migration or Edge Function deployment is required. After approval and merge, the existing production workflow tests and publishes the cache-busted Admin HTML, JavaScript, helper module, and CSS through GitHub Pages.

## Hermes continuation

```text
cd C:\Users\pimen\hereford-cup
git fetch origin
git checkout feat/responsive-member-roster
npm test
git diff origin/main...HEAD
```

Before reporting production complete, verify the production workflow for the exact merge SHA, read back `admin.html`, `admin.css?v=member-roster-grid-1`, `src/admin.js?v=member-roster-grid-1`, and `src/admin-helpers.js?v=member-roster-grid-1`, then exercise the authenticated Active Members search/filter and one existing save control without deleting a member.
