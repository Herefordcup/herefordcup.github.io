import { loadLegacyArchive, legacyPhotoUrl } from './supabase.js?v=public-preview-1';
import { renderLegacyArchive } from './legacy.js?v=legacy-scorecards-3';

const target = {
  timeline: document.querySelector('#legacyTimeline'),
  details: document.querySelector('#legacyDetails'),
  gallery: document.querySelector('#legacyGallery'),
  photoUrl: legacyPhotoUrl,
};
const legacyPhotoDialog = document.querySelector('#legacyPhotoDialog');
const legacyPhotoFull = document.querySelector('#legacyPhotoFull');
const legacyPhotoCaption = document.querySelector('#legacyPhotoCaption');

target.gallery.addEventListener('click', event => {
  const trigger = event.target.closest('.legacy-photo-open');
  if (!trigger) return;
  const image = trigger.querySelector('img');
  const caption = trigger.closest('figure')?.querySelector('figcaption')?.textContent ?? '';
  legacyPhotoFull.src = image.currentSrc || image.src;
  legacyPhotoFull.alt = image.alt;
  legacyPhotoCaption.textContent = caption;
  legacyPhotoCaption.hidden = !caption;
  legacyPhotoDialog.showModal();
});

document.querySelector('#legacyPhotoClose').addEventListener('click', () => legacyPhotoDialog.close());
legacyPhotoDialog.addEventListener('click', event => {
  if (event.target === legacyPhotoDialog) legacyPhotoDialog.close();
});

try {
  renderLegacyArchive({ ...target, editions: await loadLegacyArchive() });
} catch {
  renderLegacyArchive({ ...target, editions: [], emptyMessage: 'Past trip history is temporarily unavailable.' });
}
