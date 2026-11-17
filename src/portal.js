import { calculateCourseHandicap, netScore } from './golf.js';
import { hasSupabaseConfig } from './config.js';
import {
  canSetNewPassword,
  getCurrentSession,
  hasActiveTournamentMembership,
  loadPlayerData,
  requestPasswordReset,
  saveProfile,
  saveRound,
  setNewPassword,
  signInWithApple,
  signInWithEmail,
  signInWithGoogle,
  signOut,
  signUpWithEmail,
  validateAuthInput,
  waitForPasswordRecovery,
} from './supabase.js';

const authView = document.querySelector('#authView');
const accessPendingView = document.querySelector('#accessPendingView');
const dashboardView = document.querySelector('#dashboardView');
const setupMessage = document.querySelector('#setupMessage');
const courseSelect = document.querySelector('#courseSelect');
const teeSelect = document.querySelector('#teeSelect');
const matchSelect = document.querySelector('#matchSelect');
const handicapInput = document.querySelector('#handicapIndex');
const scorecard = document.querySelector('#scorecard');
const emptyScorecard = document.querySelector('#emptyScorecard');
const saveButton = document.querySelector('#saveRound');
const authForm = document.querySelector('#emailAuthForm');
const authMessage = document.querySelector('#authMessage');
const displayNameField = document.querySelector('#displayNameField');
const displayNameInput = document.querySelector('#displayName');
const emailInput = document.querySelector('#emailAddress');
const passwordInput = document.querySelector('#emailPassword');
const forgotPasswordButton = document.querySelector('#forgotPassword');
const authSubmitButton = document.querySelector('#emailAuthSubmit');
const signInModeButton = document.querySelector('#authModeSignIn');
const signUpModeButton = document.querySelector('#authModeSignUp');
const authModeSelector = document.querySelector('#authModeSelector');
const emailAddressField = document.querySelector('#emailAddressField');
const authDivider = document.querySelector('#authDivider');
const providerAccess = document.querySelector('#providerAccess');
const authAccessNote = document.querySelector('#authAccessNote');
const authTitle = document.querySelector('#authTitle');
const authIntro = document.querySelector('#authIntro');

let session;
let playerData;
let selectedTee;
let authMode = 'signin';
let recoveryVerified = false;
let scores = Array.from({ length: 18 }, (_, index) => ({ hole_number: index + 1, gross_score: null }));

function showAuthMessage(message, isError = false) {
  authMessage.textContent = message;
  authMessage.classList.toggle('is-error', isError);
}

function setAuthMode(mode) {
  authMode = mode;
  const isSignUp = mode === 'signup';
  const isRecovery = mode === 'recovery';
  if (!isRecovery) recoveryVerified = false;
  authSubmitButton.disabled = isRecovery && !recoveryVerified;
  displayNameField.hidden = !isSignUp;
  displayNameInput.required = isSignUp;
  emailAddressField.hidden = isRecovery;
  emailInput.required = !isRecovery;
  passwordInput.autocomplete = isSignUp || isRecovery ? 'new-password' : 'current-password';
  forgotPasswordButton.hidden = isSignUp || isRecovery;
  authSubmitButton.textContent = isRecovery ? 'Set new password' : isSignUp ? 'Create account' : 'Sign in';
  authModeSelector.hidden = isRecovery;
  authDivider.hidden = isRecovery;
  providerAccess.hidden = isRecovery;
  authAccessNote.hidden = isRecovery;
  authTitle.innerHTML = isRecovery ? 'Set a new<br><em>password.</em>' : 'Your round.<br><em>Your team.</em>';
  authIntro.textContent = isRecovery
    ? 'Choose a new password with at least 8 characters.'
    : 'Sign in or create an account to join your team, follow every match, and keep your scores in one place.';
  signInModeButton.classList.toggle('is-active', !isSignUp);
  signUpModeButton.classList.toggle('is-active', isSignUp);
  signInModeButton.setAttribute('aria-selected', String(!isSignUp));
  signUpModeButton.setAttribute('aria-selected', String(isSignUp));
  showAuthMessage('');
}

function setSyncStatus(message, busy = false) {
  const element = document.querySelector('#syncStatus');
  element.lastChild.textContent = ` ${message}`;
  element.querySelector('i').style.background = busy ? '#d99a2b' : '#46b96a';
}

function showMessage(message, isError = false) {
  const element = document.querySelector('#saveMessage');
  element.textContent = message;
  element.style.color = isError ? '#9b1730' : '';
}

function currentCourse() {
  return playerData?.courses.find(course => course.id === courseSelect.value);
}

function updateCourseHandicap() {
  if (!selectedTee || handicapInput.value === '') {
    document.querySelector('#courseHandicap').textContent = '—';
    return null;
  }
  const handicap = calculateCourseHandicap(
    handicapInput.value,
    selectedTee.slope,
    selectedTee.rating,
    selectedTee.par,
  );
  document.querySelector('#courseHandicap').textContent = handicap;
  updateSummary();
  return handicap;
}

function updateSummary() {
  const completed = scores.filter(score => Number(score.gross_score) > 0);
  const gross = completed.reduce((total, score) => total + Number(score.gross_score), 0);
  const holes = selectedTee?.holes ?? [];
  const par = completed.reduce((total, score) => {
    const hole = holes.find(item => item.hole_number === score.hole_number);
    return total + Number(hole?.par ?? 0);
  }, 0);
  const courseHandicap = selectedTee && handicapInput.value !== ''
    ? calculateCourseHandicap(handicapInput.value, selectedTee.slope, selectedTee.rating, selectedTee.par)
    : 0;
  const net = completed.reduce((total, score) => {
    const hole = holes.find(item => item.hole_number === score.hole_number);
    return total + netScore(score.gross_score, courseHandicap, hole?.stroke_index ?? score.hole_number);
  }, 0);
  document.querySelector('#holesCompleted').textContent = completed.length;
  document.querySelector('#grossTotal').textContent = completed.length ? gross : '—';
  document.querySelector('#netTotal').textContent = completed.length ? net : '—';
  const relation = gross - par;
  document.querySelector('#toPar').textContent = !completed.length ? 'E' : relation === 0 ? 'E' : relation > 0 ? `+${relation}` : relation;
  saveButton.disabled = !selectedTee || !completed.length;
}

function renderScorecard() {
  const holes = [...(selectedTee?.holes ?? [])].sort((a, b) => a.hole_number - b.hole_number);
  if (!holes.length) {
    scorecard.hidden = true;
    emptyScorecard.hidden = false;
    return;
  }
  emptyScorecard.hidden = true;
  scorecard.hidden = false;
  scorecard.replaceChildren(...holes.map(hole => {
    const row = document.createElement('div');
    row.className = 'hole-row';
    const current = scores[hole.hole_number - 1];
    row.innerHTML = `
      <div class="hole-id">${hole.hole_number}</div>
      <div class="hole-meta"><strong>Par ${hole.par}</strong><span>${hole.yardage ? `${hole.yardage} YDS` : ''}</span><span>SI ${hole.stroke_index}</span></div>
      <div class="score-stepper">
        <button type="button" aria-label="Decrease hole ${hole.hole_number} score">−</button>
        <input type="number" inputmode="numeric" min="1" max="15" aria-label="Hole ${hole.hole_number} gross score" value="${current.gross_score ?? ''}">
        <button type="button" aria-label="Increase hole ${hole.hole_number} score">+</button>
      </div>`;
    const input = row.querySelector('input');
    const commit = value => {
      current.gross_score = value >= 1 ? Math.min(15, value) : null;
      input.value = current.gross_score ?? '';
      updateSummary();
    };
    row.querySelectorAll('button')[0].addEventListener('click', () => commit((Number(input.value) || hole.par) - 1));
    row.querySelectorAll('button')[1].addEventListener('click', () => commit((Number(input.value) || hole.par - 1) + 1));
    input.addEventListener('input', () => commit(Number(input.value)));
    return row;
  }));
  updateSummary();
}

function populateCourses() {
  for (const course of playerData.courses) {
    courseSelect.add(new Option(course.name, course.id));
  }
  for (const assignment of playerData.assignments) {
    const match = assignment.matches;
    if (!match) continue;
    const label = `${match.name} · ${match.format.replace('fourball', 'Four-Ball')} · ${assignment.team}`;
    matchSelect.add(new Option(label, match.id));
  }
}

courseSelect.addEventListener('change', () => {
  const course = currentCourse();
  teeSelect.replaceChildren(new Option('Select tees', ''));
  teeSelect.disabled = !course;
  for (const tee of course?.tees ?? []) teeSelect.add(new Option(`${tee.name} · ${tee.yardage || '—'} yards`, tee.id));
  selectedTee = undefined;
  scores = scores.map(score => ({ ...score, gross_score: null }));
  renderScorecard();
  updateCourseHandicap();
});

teeSelect.addEventListener('change', () => {
  selectedTee = currentCourse()?.tees.find(tee => tee.id === teeSelect.value);
  const facts = document.querySelectorAll('#teeFacts b');
  facts[0].textContent = selectedTee?.rating ?? '—';
  facts[1].textContent = selectedTee?.slope ?? '—';
  facts[2].textContent = selectedTee?.par ?? '—';
  scores = scores.map(score => ({ ...score, gross_score: null }));
  updateCourseHandicap();
  renderScorecard();
});

handicapInput.addEventListener('input', updateCourseHandicap);
matchSelect.addEventListener('change', () => {
  const assignment = playerData.assignments.find(item => item.matches?.id === matchSelect.value);
  const match = assignment?.matches;
  document.querySelector('#matchFormat').textContent = match ? match.format.replace('fourball', 'Four-Ball').replace('foursomes', 'Foursomes').replace('singles', 'Singles') : 'Individual';
  document.querySelector('#scoringMode').textContent = match ? `${match.scoring_mode[0].toUpperCase()}${match.scoring_mode.slice(1)}` : 'Gross';
});

saveButton.addEventListener('click', async () => {
  try {
    setSyncStatus('Saving…', true);
    showMessage('');
    const courseHandicap = updateCourseHandicap();
    await saveProfile(session.user.id, playerData.profile.display_name, handicapInput.value || 0);
    await saveRound({
      userId: session.user.id,
      matchId: matchSelect.value || null,
      courseId: courseSelect.value,
      teeId: teeSelect.value,
      courseHandicap,
      scores,
    });
    setSyncStatus('Saved');
    showMessage('Round saved to the Hereford Cup.');
  } catch (error) {
    setSyncStatus('Save failed', true);
    showMessage(error.message, true);
  }
});

signInModeButton.addEventListener('click', () => setAuthMode('signin'));
signUpModeButton.addEventListener('click', () => setAuthMode('signup'));

authForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (authMode === 'recovery' && !canSetNewPassword(authMode, recoveryVerified)) {
    showAuthMessage('Verify the password reset link before choosing a new password.', true);
    return;
  }
  const values = {
    mode: authMode,
    displayName: displayNameInput.value,
    email: emailInput.value,
    password: passwordInput.value,
  };
  const errors = validateAuthInput(values);
  if (Object.keys(errors).length) {
    showAuthMessage(Object.values(errors)[0], true);
    return;
  }
  try {
    authSubmitButton.disabled = true;
    showAuthMessage(authMode === 'recovery'
      ? 'Saving your new password…'
      : authMode === 'signup' ? 'Creating your account…' : 'Signing in…');
    if (authMode === 'recovery') {
      await setNewPassword(values.password);
      await signOut();
      window.history.replaceState({}, '', new URL('portal.html', window.location.href).href);
      passwordInput.value = '';
      setAuthMode('signin');
      showAuthMessage('Password updated. Sign in with your new password.');
      return;
    }
    if (authMode === 'signup') {
      const result = await signUpWithEmail(values);
      if (!result.session) {
        showAuthMessage('Check your email to verify your account, then return here to sign in.');
        return;
      }
    } else {
      await signInWithEmail(values.email, values.password);
    }
    window.location.reload();
  } catch (error) {
    showAuthMessage(error.message, true);
  } finally {
    authSubmitButton.disabled = false;
  }
});

forgotPasswordButton.addEventListener('click', async () => {
  const errors = validateAuthInput({ mode: 'signin', email: emailInput.value, password: 'recovery' });
  if (errors.email) {
    showAuthMessage(errors.email, true);
    return;
  }
  try {
    await requestPasswordReset(emailInput.value);
    showAuthMessage('Password reset instructions are on the way.');
  } catch (error) {
    showAuthMessage(error.message, true);
  }
});

async function beginProviderSignIn(action) {
  try {
    showAuthMessage('Opening secure sign-in…');
    await action();
  } catch (error) {
    showAuthMessage(error.message, true);
  }
}

document.querySelector('#googleSignIn').addEventListener('click', () => beginProviderSignIn(signInWithGoogle));
document.querySelector('#appleSignIn').addEventListener('click', () => beginProviderSignIn(signInWithApple));
document.querySelector('#signOutButton').addEventListener('click', async () => { await signOut(); window.location.reload(); });

async function start() {
  if (!hasSupabaseConfig()) {
    setupMessage.hidden = false;
    return;
  }
  try {
    const isRecovery = new URL(window.location.href).searchParams.get('recovery') === '1';
    if (isRecovery) {
      authView.hidden = false;
      accessPendingView.hidden = true;
      dashboardView.hidden = true;
      setAuthMode('recovery');
      recoveryVerified = false;
      authSubmitButton.disabled = true;
      showAuthMessage('Verifying your password reset link…');
      session = await waitForPasswordRecovery();
      if (!session) {
        showAuthMessage('This password reset link is invalid or has expired. Request a new link.', true);
      } else {
        recoveryVerified = true;
        authSubmitButton.disabled = false;
        showAuthMessage('Reset link verified. Choose your new password.');
      }
      return;
    }
    session = await getCurrentSession();
    if (!session) return;
    authView.hidden = true;
    document.querySelector('#signOutButton').hidden = false;
    document.querySelector('#playerIdentity').textContent = session.user.email;
    playerData = await loadPlayerData(session.user.id);
    document.querySelector('#adminLink').hidden = playerData.profile.role !== 'admin';
    if (playerData.profile.role !== 'admin' && !hasActiveTournamentMembership(playerData.memberships)) {
      accessPendingView.hidden = false;
      dashboardView.hidden = true;
      return;
    }
    accessPendingView.hidden = true;
    dashboardView.hidden = false;
    setSyncStatus('Loading…', true);
    document.querySelector('#playerName').textContent = playerData.profile.display_name || session.user.user_metadata?.full_name || 'Golfer';
    handicapInput.value = playerData.profile.handicap_index ?? '';
    populateCourses();
    setSyncStatus('Synced');
  } catch (error) {
    authView.hidden = false;
    accessPendingView.hidden = true;
    dashboardView.hidden = true;
    setupMessage.hidden = false;
    setupMessage.querySelector('p').textContent = error.message;
  }
}

start();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    registrations.forEach(registration => registration.unregister());
  });
}
if ('caches' in window) {
  caches.keys().then(keys => keys.filter(key => key.startsWith('hereford-cup-')).forEach(key => caches.delete(key)));
}
