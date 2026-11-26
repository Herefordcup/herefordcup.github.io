const tools = [
  ['members', 'Members', '#membershipManagement'],
  ['matches', 'Match planning', '#matchPlanForm'],
  ['scramble', 'Texas Scramble', '#texasScrambleForm'],
  ['scorecards', 'Scorecards', '.admin-panel #resultFinalizationForm, .admin-panel #resultMatch'],
  ['completion', 'Tournament completion', '#tournamentCompletionForm'],
  ['rules', 'Rules', '#ruleForm'],
  ['commentary', 'Commentary', '#commentarySettingsForm'],
  ['legacy', 'Legacy / Past Trips', '.legacy-workspace'],
  ['courses', 'Courses', '#courseForm'],
];

function mountAdminWorkspaces(root) {
  if (!root) return;
  const chooser = document.createElement('select');
  chooser.id = 'adminTool';
  const panels = new Map();
  for (const [value, label, anchor] of tools) {
    const panel = root.querySelector(anchor)?.closest('.admin-panel');
    if (!panel) return; // Keep the full original page if a workspace cannot be identified.
    panels.set(value, panel);
    chooser.add(new Option(label, value));
  }
  chooser.add(new Option('All tools', 'all'));
  const bookmarked = new URLSearchParams(location.search).get('tool');
  chooser.value = panels.has(bookmarked) || bookmarked === 'all' ? bookmarked : 'scorecards';

  const label = document.createElement('label');
  label.className = 'admin-tool-picker';
  label.htmlFor = chooser.id;
  label.textContent = 'Admin tool';
  label.append(chooser);

  const grid = panels.get('rules').closest('.admin-grid');
  function showSelection() {
    for (const [value, panel] of panels) {
      panel.classList.toggle('admin-workspace-hidden', chooser.value !== 'all' && chooser.value !== value);
    }
    if (grid) {
      const singleInGrid = grid.contains(panels.get(chooser.value) ?? null);
      grid.classList.toggle('admin-workspace-hidden', chooser.value !== 'all' && !singleInGrid);
      grid.classList.toggle('admin-workspace-single', singleInGrid);
    }
  }
  showSelection();
  chooser.addEventListener('change', () => {
    showSelection();
    const url = new URL(location.href);
    url.searchParams.set('tool', chooser.value);
    history.replaceState(history.state, '', url);
  });
  root.prepend(label); // The existing Admin gate owns this root's visibility.
}

mountAdminWorkspaces(document.querySelector('#adminContent'));
