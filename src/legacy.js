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
  return [...(editions ?? [])]
    .sort((left, right) => left.edition_year - right.edition_year);
}

function recordedNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function legacyOutcome(edition = {}) {
  if (edition.winner_name) {
    return { label: 'CHAMPION', title: edition.winner_name, score: edition.final_score || null };
  }
  const confirmedTie = edition.score_confidence === 'confirmed'
    && recordedNumber(edition.cardinal_total)
    && recordedNumber(edition.silver_total)
    && Math.abs(edition.cardinal_total - edition.silver_total) < 0.000001;
  if (confirmedTie && edition.final_score) {
    return { label: 'FINAL RESULT', title: 'Tie', score: edition.final_score };
  }
  return null;
}

function resultIsUnresolved(result) {
  if (!recordedNumber(result.points_available)) return false;
  const blue = recordedNumber(result.cardinal_points) ? result.cardinal_points : null;
  const white = recordedNumber(result.silver_points) ? result.silver_points : null;
  return result.confidence === 'unresolved'
    || blue === null
    || white === null
    || blue + white < result.points_available;
}

export function groupLegacyResults(results = []) {
  const groups = new Map();
  const ordered = [...results]
    .filter(result => result.public_visible !== false && result.event_group?.trim() !== 'Reconciliation')
    .sort((left, right) => Number(left.sort_order ?? 0) - Number(right.sort_order ?? 0));
  for (const result of ordered) {
    const name = result.event_group?.trim() || 'Other results';
    if (!groups.has(name)) {
      groups.set(name, {
        name,
        results: [],
        pointsAvailable: 0,
        bluePoints: 0,
        whitePoints: 0,
        unresolvedRows: 0,
        hasPoints: false,
      });
    }
    const group = groups.get(name);
    group.results.push(result);
    if (recordedNumber(result.points_available)) group.pointsAvailable += result.points_available;
    if (recordedNumber(result.cardinal_points)) {
      group.bluePoints += result.cardinal_points;
      group.hasPoints = true;
    }
    if (recordedNumber(result.silver_points)) {
      group.whitePoints += result.silver_points;
      group.hasPoints = true;
    }
    if (resultIsUnresolved(result)) group.unresolvedRows += 1;
  }
  return [...groups.values()];
}

function pointsText(value) {
  return recordedNumber(value) ? String(value) : '—';
}

export function renderLegacyWinners({ container, editions, emptyMessage = 'Champions will appear after results are published.' }) {
  const champions = normalizedEditions(editions)
    .filter(edition => edition.winner_name)
    .sort((left, right) => right.edition_year - left.edition_year);
  container.replaceChildren();
  if (!champions.length) {
    container.append(node('p', 'legacy-pending', emptyMessage));
    return;
  }
  for (const edition of champions) {
    const champion = node('article', 'legacy-champion');
    champion.append(node('span', '', String(edition.edition_year)));
    const identity = node('div');
    identity.append(node('small', '', 'CHAMPION'));
    identity.append(node('strong', '', edition.winner_name));
    champion.append(identity);
    container.append(champion);
  }
}

export function renderLegacyArchive({ timeline, details, gallery, editions, photoUrl, emptyMessage = 'No published Legacy editions yet.' }) {
  const archive = normalizedEditions(editions);
  timeline.replaceChildren();
  details.replaceChildren();
  gallery.replaceChildren();
  if (!archive.length) {
    details.append(node('p', 'legacy-pending', emptyMessage));
    return;
  }
  let selected = archive.find(edition => edition.status === 'planned') ?? archive.at(-1);

  function renderSelected() {
    details.replaceChildren();
    gallery.replaceChildren();
    timeline.querySelectorAll('button').forEach(button => {
      const active = Number(button.dataset.year) === selected.edition_year;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      if (active) details.setAttribute('aria-labelledby', button.id);
    });

    const heading = node('div', 'legacy-edition-heading');
    heading.append(node('span', '', String(selected.edition_year)));
    const title = node('div');
    title.append(node('p', 'eyebrow', selected.status === 'planned' ? 'NEXT CHAPTER' : 'CUP HISTORY'));
    title.append(node('h3', '', selected.venue));
    title.append(node('strong', '', selected.destination));
    heading.append(title);
    details.append(heading);

    const outcome = legacyOutcome(selected);
    if (outcome) {
      const winner = node('div', 'legacy-winner');
      winner.append(node('small', '', outcome.label));
      winner.append(node('strong', '', outcome.title));
      if (outcome.score) winner.append(node('span', '', outcome.score));
      details.append(winner);
    } else {
      details.append(node('p', 'legacy-pending', selected.status === 'planned'
        ? 'The Pinehurst chapter is still being written.'
        : 'Winner and score details can be added from Tournament Admin.'));
    }

    if (selected.story) details.append(node('p', 'legacy-story', selected.story));

    const resultGroups = groupLegacyResults(selected.legacy_results ?? []);
    for (const group of resultGroups) {
      const disclosure = node('details', 'legacy-result-group');
      disclosure.open = true;
      const groupSummary = node('summary');
      groupSummary.append(node('span', '', group.name));
      const groupMeta = group.hasPoints
        ? `Blue ${pointsText(group.bluePoints)} · White ${pointsText(group.whitePoints)}`
        : `${group.results.length} matches`;
      groupSummary.append(node('small', '', groupMeta));
      disclosure.append(groupSummary);
      const list = node('div', 'legacy-results');
      for (const result of group.results) {
        const row = node('article');
        const matchType = result.format_label || group.name;
        row.append(node('small', 'legacy-result-format', matchType));
        const sides = [result.cardinal_entry, result.silver_entry].filter(Boolean).join(' vs ');
        row.append(node('strong', '', sides || result.label));
        row.append(node('span', '', result.result));
        if (recordedNumber(result.cardinal_points) || recordedNumber(result.silver_points)) {
          row.append(node(
            'span',
            'legacy-result-points',
            `Blue ${pointsText(result.cardinal_points)} · White ${pointsText(result.silver_points)}`,
          ));
        }
        list.append(row);
      }
      disclosure.append(list);
      details.append(disclosure);
    }

    for (const photo of [...(selected.legacy_photos ?? [])].sort((a, b) => a.sort_order - b.sort_order)) {
      const figure = node('figure', 'legacy-photo');
      const openButton = node('button', 'legacy-photo-open');
      openButton.type = 'button';
      openButton.setAttribute('aria-label', `View ${photo.caption || `${selected.venue} ${selected.edition_year}`} full size`);
      const image = node('img');
      image.src = photoUrl(photo);
      image.alt = photo.caption || `${selected.venue} ${selected.edition_year}`;
      image.loading = 'lazy';
      openButton.append(image);
      figure.append(openButton);
      if (photo.caption) figure.append(node('figcaption', '', photo.caption));
      gallery.append(figure);
    }
  }

  const buttons = [];
  for (const [index, edition] of archive.entries()) {
    const button = node('button', '', String(edition.edition_year));
    button.type = 'button';
    button.id = `legacy-tab-${edition.edition_year}`;
    button.dataset.year = String(edition.edition_year);
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', details.id);
    button.append(node('small', '', edition.venue));
    button.addEventListener('click', () => {
      selected = edition;
      renderSelected();
    });
    button.addEventListener('keydown', event => {
      let nextIndex;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % archive.length;
      if (event.key === 'ArrowLeft') nextIndex = (index - 1 + archive.length) % archive.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = archive.length - 1;
      if (nextIndex === undefined) return;
      event.preventDefault();
      selected = archive[nextIndex];
      renderSelected();
      buttons[nextIndex].focus();
    });
    buttons.push(button);
    timeline.append(button);
  }
  details.setAttribute('role', 'tabpanel');
  details.tabIndex = 0;
  renderSelected();
}
