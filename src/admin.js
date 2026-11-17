import { getCurrentSession, loadPlayerData, saveCourseWithTee } from './supabase.js';

const form = document.querySelector('#courseForm');
const holesContainer = document.querySelector('#adminHoles');
const message = document.querySelector('#adminMessage');
const defaultPars = [4,4,3,5,4,4,3,5,4,4,4,3,5,4,4,3,5,4];

for (let hole = 1; hole <= 18; hole += 1) {
  const row = document.createElement('div');
  row.className = 'admin-hole';
  row.innerHTML = `<strong>${hole}</strong><label>Par<input name="hole-${hole}-par" type="number" min="3" max="6" value="${defaultPars[hole - 1]}" required></label><label>SI<input name="hole-${hole}-si" type="number" min="1" max="18" value="${hole}" required></label><label>Yards<input name="hole-${hole}-yards" type="number" min="50" max="750"></label>`;
  holesContainer.append(row);
}

let session;
let profile;

form.addEventListener('submit', async event => {
  event.preventDefault();
  message.textContent = 'Saving…';
  try {
    const data = new FormData(form);
    const holes = Array.from({ length: 18 }, (_, index) => ({
      hole_number: index + 1,
      par: data.get(`hole-${index + 1}-par`),
      stroke_index: data.get(`hole-${index + 1}-si`),
      yardage: data.get(`hole-${index + 1}-yards`),
    }));
    const strokeIndexes = new Set(holes.map(hole => Number(hole.stroke_index)));
    if (strokeIndexes.size !== 18) throw new Error('Each stroke index from 1 through 18 must be used once.');
    await saveCourseWithTee({
      userId: session.user.id,
      course: { name: data.get('courseName'), location: data.get('location') },
      tee: { name: data.get('teeName'), rating: data.get('rating'), slope: data.get('slope'), par: data.get('par'), yardage: data.get('yardage') },
      holes,
    });
    message.textContent = 'Course and tee saved.';
    form.reset();
  } catch (error) {
    message.textContent = error.message;
    message.style.color = '#9b1730';
  }
});

async function start() {
  try {
    session = await getCurrentSession();
    if (!session) throw new Error('Sign in through the player portal first.');
    const data = await loadPlayerData(session.user.id);
    profile = data.profile;
    if (profile.role !== 'admin') throw new Error('This page is limited to the tournament administrator.');
  } catch (error) {
    form.hidden = true;
    message.textContent = error.message;
    message.style.color = '#9b1730';
  }
}

start();
