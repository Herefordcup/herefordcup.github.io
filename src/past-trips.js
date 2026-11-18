import { loadLegacyArchive, legacyPhotoUrl } from './supabase.js';
import { renderLegacyArchive } from './legacy.js';

const target = {
  timeline: document.querySelector('#legacyTimeline'),
  details: document.querySelector('#legacyDetails'),
  gallery: document.querySelector('#legacyGallery'),
  photoUrl: legacyPhotoUrl,
};

try {
  renderLegacyArchive({ ...target, editions: await loadLegacyArchive() });
} catch {
  renderLegacyArchive({ ...target, editions: [], emptyMessage: 'Past trip history is temporarily unavailable.' });
}
