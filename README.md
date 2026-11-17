# Hereford Cup

A mobile-first browser website for the annual Ryder Cup-style Hereford Cup golf trip.

## Features

- Email/password account creation with email verification and password recovery
- Google sign-in through Supabase Auth
- Invitation or administrator approval required for tournament membership
- Individual player profiles and handicap indexes
- Administrator-managed courses, tees, ratings, slopes, pars, and hole data
- Mobile hole-by-hole gross score entry
- Gross or net match play for Singles, Four-Ball, and Foursomes
- Automatic course handicaps, net scores, match status, and Cup points
- Browser-based website for phones, tablets, and computers

## Supabase setup

1. Create a Supabase project.
2. Run `supabase/migrations/001_hereford_cup.sql`, then `supabase/migrations/002_tournament_access.sql`, in the SQL editor.
3. Enable Email under Authentication > Providers, require email confirmation, and disable anonymous access.
4. Configure Google under Authentication > Providers.
5. Set the production site URL to `https://pimentelaj.github.io/hereford-cup/` and allow `https://pimentelaj.github.io/hereford-cup/portal.html` plus `https://pimentelaj.github.io/hereford-cup/portal.html?recovery=1` as redirect URLs.
6. Add the project URL and publishable key to `src/config.js`.
7. Sign in once and promote the tournament administrator as described at the bottom of the migration.

The browser receives only Supabase's publishable key. Database writes are protected by row-level security; never put a service-role key in this repository.

## Local development

```sh
npm test
npm run serve
```

## Hosting

The static browser interface is deployed through GitHub Pages. Supabase provides authentication and will become the authoritative shared source for membership, tournaments, pairings, scores, and standings once the project is connected and its migrations are applied.
