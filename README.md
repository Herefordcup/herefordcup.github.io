# Hereford Cup

An installable, mobile-first Ryder Cup-style tournament site for the annual Hereford Cup golf trip.

## Features

- Google sign-in through Supabase Auth
- Individual player profiles and handicap indexes
- Administrator-managed courses, tees, ratings, slopes, pars, and hole data
- Mobile hole-by-hole gross score entry
- Gross or net match play for Singles, Four-Ball, and Foursomes
- Automatic course handicaps, net scores, match status, and Cup points
- Browser-based website for phones, tablets, and computers

## Supabase setup

1. Create a Supabase project.
2. Run `supabase/migrations/001_hereford_cup.sql` in its SQL editor.
3. Enable Google under Authentication > Providers.
4. Set the production site URL to `https://pimentelaj.github.io/hereford-cup/` and allow `https://pimentelaj.github.io/hereford-cup/portal.html` as a redirect URL.
5. Add the project URL and publishable key to `src/config.js`.
6. Sign in once and promote the tournament administrator as described at the bottom of the migration.

The browser receives only Supabase's publishable key. Database writes are protected by row-level security; never put a service-role key in this repository.

## Local development

```sh
npm test
npm run serve
```

## Hosting

The site is deployed through GitHub Pages. This first edition stores scores on the current device. A shared live-scoring backend can be connected after teams, players, dates, and tournament rules are finalized.
