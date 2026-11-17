export const knownLegacyTrips = [
  { edition_year: 2023, venue: 'Barefoot', destination: 'Myrtle Beach', status: 'completed', legacy_results: [], legacy_photos: [] },
  { edition_year: 2024, venue: 'Innisbrook', destination: 'Tampa', status: 'completed', legacy_results: [], legacy_photos: [] },
  { edition_year: 2025, venue: 'PGA Frisco', destination: 'Texas', status: 'completed', legacy_results: [], legacy_photos: [] },
  { edition_year: 2026, venue: 'Kiawah', destination: 'South Carolina', status: 'completed', legacy_results: [], legacy_photos: [] },
  { edition_year: 2027, venue: 'Pinehurst', destination: 'North Carolina', status: 'planned', legacy_results: [], legacy_photos: [] },
];

function node(tag, className, text) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

function normalizedEditions(editions) {
  return [...(editions?.length ? editions : knownLegacyTrips)]
    .sort((left, right) => left.edition_year - right.edition_year);
}

export function renderLegacyArchive({ timeline, details, gallery, editions, photoUrl }) {
  const archive = normalizedEditions(editions);
  let selected = archive.find(edition => edition.status === 'planned') ?? archive.at(-1);

  function renderSelected() {
    details.replaceChildren();
    gallery.replaceChildren();
    timeline.querySelectorAll('button').forEach(button => {
      const active = Number(button.dataset.year) === selected.edition_year;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });

    const heading = node('div', 'legacy-edition-heading');
    heading.append(node('span', '', String(selected.edition_year)));
    const title = node('div');
    title.append(node('p', 'eyebrow', selected.status === 'planned' ? 'NEXT CHAPTER' : 'CUP HISTORY'));
    title.append(node('h3', '', selected.venue));
    title.append(node('strong', '', selected.destination));
    heading.append(title);
    details.append(heading);

    if (selected.winner_name) {
      const winner = node('div', 'legacy-winner');
      winner.append(node('small', '', 'CHAMPION'));
      winner.append(node('strong', '', selected.winner_name));
      if (selected.final_score) winner.append(node('span', '', selected.final_score));
      details.append(winner);
    } else {
      details.append(node('p', 'legacy-pending', selected.status === 'planned'
        ? 'The Pinehurst chapter is still being written.'
        : 'Winner and score details can be added from Tournament Admin.'));
    }

    if (selected.story) details.append(node('p', 'legacy-story', selected.story));

    const results = [...(selected.legacy_results ?? [])].sort((a, b) => a.sort_order - b.sort_order);
    if (results.length) {
      const list = node('div', 'legacy-results');
      for (const result of results) {
        const row = node('article');
        row.append(node('small', '', result.label));
        row.append(node('strong', '', result.result));
        const sides = [result.cardinal_entry, result.silver_entry].filter(Boolean).join(' · ');
        if (sides) row.append(node('span', '', sides));
        list.append(row);
      }
      details.append(list);
    }

    for (const photo of [...(selected.legacy_photos ?? [])].sort((a, b) => a.sort_order - b.sort_order)) {
      const figure = node('figure', 'legacy-photo');
      const image = node('img');
      image.src = photoUrl(photo.storage_path);
      image.alt = photo.caption || `${selected.venue} ${selected.edition_year}`;
      image.loading = 'lazy';
      figure.append(image);
      if (photo.caption) figure.append(node('figcaption', '', photo.caption));
      gallery.append(figure);
    }
  }

  timeline.replaceChildren();
  for (const edition of archive) {
    const button = node('button', '', String(edition.edition_year));
    button.type = 'button';
    button.dataset.year = String(edition.edition_year);
    button.setAttribute('role', 'tab');
    button.append(node('small', '', edition.venue));
    button.addEventListener('click', () => {
      selected = edition;
      renderSelected();
    });
    timeline.append(button);
  }
  renderSelected();
}
