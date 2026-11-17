export function normalizeProfileInput(displayName, handicapIndex) {
  const name = String(displayName ?? '').trim();
  const handicap = Number(handicapIndex);
  if (name.length < 2 || name.length > 60) {
    throw new Error('Display name must be 2 through 60 characters.');
  }
  if (!Number.isFinite(handicap) || handicap < -10 || handicap > 54) {
    throw new Error('Handicap index must be between -10 and 54.');
  }
  return { displayName: name, handicapIndex: handicap };
}

export function avatarInitials(displayName) {
  const parts = String(displayName ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'HC';
  return `${parts[0][0]}${parts.length > 1 ? parts.at(-1)[0] : ''}`.toUpperCase();
}

export function profileAvatarUrl(metadata = {}) {
  const candidate = metadata.avatar_url || metadata.picture;
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
