const tools = [
  ['members', 'Members', '#membershipManagement'],
  ['matches', 'Match planning', '#matchPlanForm'],
  ['scramble', 'Texas Scramble', '#texasScrambleForm'],
  ['scorecards', 'Scorecards', '.admin-panel #resultFinalizationForm, .admin-panel #resultMatch'],
  ['completion', 'Tournament completion', '#tournamentCompletionForm'],
  ['rules', 'Rules', '#ruleForm'],
  ['commentary', 'Commentary', '#commentarySettingsForm'],
  ['legacy', 'Past Trips', '.legacy-workspace'],
  ['courses', 'Courses', '#courseForm'],
];

const menus = new Map([
  ['home', { title: 'Tournament Admin', items: [
    ['scorecards', 'Scorecards', 'Review a round or correct a submitted hole.'],
    ['players', 'Players & teams', 'Membership requests, team roster and handicaps.'],
    ['rounds', 'Rounds & pairings', 'Match formats, playing groups, courses and tees.'],
    ['tournament', 'Tournament tools', 'Playing rules, commentary and Past Trips.'],
  ] }],
  ['players', { title: 'Players & teams', items: [
    ['requests', 'Membership requests', 'Review pending players.'],
    ['roster', 'Team roster', 'Edit a player’s team, handicap or role.'],
  ] }],
  ['rounds', { title: 'Rounds & pairings', items: [
    ['matches', 'Match plans & pairings', 'Set the format, hole ranges and opponents.'],
    ['scramble', 'Texas Scramble lineups', 'Set tee groups and shared scoring rules.'],
    ['courses', 'Courses & tees', 'Manage tees, ratings and hole details.'],
  ] }],
  ['tournament', { title: 'Tournament tools', items: [
    ['rules', 'Playing rules', 'Edit the rules shown to players.'],
    ['commentary', 'Match commentary', 'Manage recaps and commentary settings.'],
    ['legacy', 'Past Trips', 'Edit an edition, result or photo.'],
    ['completion', 'Finish tournament', 'Review the results before publishing.'],
  ] }],
]);

function linkUrl(route) {
  const url = new URL(location.href);
  if (route === 'home') url.searchParams.delete('tool');
  else url.searchParams.set('tool', route);
  return url;
}

function menuLink([id, name, description]) {
  const link = document.createElement('a');
  link.className = 'admin-section-link';
  link.dataset.adminRoute = id;
  link.href = linkUrl(id).href;
  const copy = document.createElement('span');
  const title = document.createElement('strong');
  const detail = document.createElement('small');
  title.id = `admin-route-title-${id}`;
  detail.id = `admin-route-description-${id}`;
  title.textContent = name;
  detail.textContent = description;
  if (id === 'players' || id === 'requests') {
    const count = document.createElement('span');
    count.className = 'admin-pending-count';
    detail.prepend(count);
  }
  link.setAttribute('aria-labelledby', title.id);
  link.setAttribute('aria-describedby', detail.id);
  copy.append(title, detail);
  const arrow = document.createElement('span');
  arrow.className = 'admin-route-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '›';
  link.append(copy, arrow);
  return link;
}

function mountAdminWorkspaces(root) {
  if (!root) return;
  const chooser = document.createElement('select');
  chooser.id = 'adminTool';
  const panels = new Map();
  for (const [value, label, anchor] of tools) {
    const panel = root.querySelector(anchor)?.closest('.admin-panel');
    if (!panel) return; // Fall back to all original panels rather than strand a workspace.
    panels.set(value, panel);
    chooser.add(new Option(label, value));
  }
  const membershipParts = new Map([['requests', '#pendingMembers'], ['roster', '#activeMembers']].map(([id, selector]) => [id, root.querySelector(selector)?.closest('section')]));
  if ([...membershipParts.values()].some(part => !part)) return;
  chooser.add(new Option('Membership requests', 'requests'));
  chooser.add(new Option('Team roster', 'roster'));
  chooser.add(new Option('All tools', 'all'));
  const parents = new Map([['members', 'players'], ['all', 'home']]);
  for (const [parent, { items }] of menus) for (const [child] of items) parents.set(child, parent);
  const routeFromUrl = () => {
    const id = new URL(location.href).searchParams.get('tool');
    return menus.has(id) || parents.has(id) ? id : 'home';
  };

  const shell = document.createElement('div');
  shell.id = 'adminWorkspaceNav';
  const bar = document.createElement('div');
  bar.className = 'admin-nav-toolbar';
  const back = document.createElement('a');
  back.id = 'adminBack';
  const label = document.createElement('label');
  label.className = 'admin-tool-picker';
  label.htmlFor = chooser.id;
  label.textContent = 'Admin tool';
  label.append(chooser);
  bar.append(back, label);
  const menu = document.createElement('section');
  menu.className = 'admin-menu';
  const heading = document.createElement('h1');
  heading.id = 'adminMenuHeading';
  heading.tabIndex = -1;
  const list = document.createElement('nav');
  list.id = 'adminSectionLinks';
  menu.append(heading, list);
  shell.append(bar, menu);
  root.prepend(shell); // The original authenticated Admin gate controls this whole subtree.
  const grid = panels.get('rules').closest('.admin-grid');
  let current;
  const pending = root.querySelector('#pendingMembers');
  function updatePendingCount() {
    const badge = list.querySelector('.admin-pending-count');
    if (!badge || menu.hidden) return;
    const n = pending.querySelectorAll(':scope > .membership-card').length;
    badge.textContent = n ? `${n} pending ${n === 1 ? 'request' : 'requests'} · ` : '';
  }
  // Reuse the authorized roster already rendered. Do not fetch member details for the home screen.
  new MutationObserver(updatePendingCount).observe(pending, { childList: true });

  function show(route, focus = false) {
    const previous = current;
    current = route;
    const group = menus.get(route);
    const selectedPanel = membershipParts.has(route) ? 'members' : route;
    for (const [id, panel] of panels) panel.classList.toggle('admin-workspace-hidden', route !== 'all' && id !== selectedPanel);
    for (const [id, part] of membershipParts) part.classList.toggle('admin-workspace-hidden', membershipParts.has(route) && route !== id);
    if (grid) {
      const single = grid.contains(panels.get(selectedPanel) ?? null);
      grid.classList.toggle('admin-workspace-hidden', route !== 'all' && !single);
      grid.classList.toggle('admin-workspace-single', single);
    }
    root.dataset.adminRoute = route;
    menu.hidden = !group;
    bar.hidden = route === 'home';
    label.hidden = Boolean(group);
    const parent = parents.get(route) || 'home';
    back.href = linkUrl(parent).href;
    back.dataset.adminRoute = parent;
    back.textContent = `‹ Back to ${parent === 'home' ? 'Admin' : menus.get(parent).title}`;
    if (group) {
      heading.textContent = group.title;
      list.setAttribute('aria-label', route === 'home' ? 'Admin sections' : group.title);
      list.replaceChildren(...group.items.map(menuLink));
      updatePendingCount();
    } else chooser.value = route;
    if (focus && !root.hidden) {
      const returnedLink = group && [...list.children].find(link => link.dataset.adminRoute === previous);
      const destination = group ? returnedLink || heading : route === 'scorecards' ? root.querySelector('#resultMatch') : back;
      destination.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  }

  show(routeFromUrl());
  function navigate(route, focus) {
    if (route === current) return;
    history.pushState({ ...history.state, adminFrom: current }, '', linkUrl(route));
    show(route, focus);
  }
  shell.addEventListener('click', event => {
    const link = event.target.closest('a[data-admin-route]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const route = link.dataset.adminRoute;
    // Go up within Admin even when the user arrived on a direct tool bookmark.
    if (link === back && history.state?.adminFrom === route) history.back();
    else navigate(route, true);
  });
  chooser.addEventListener('change', () => {
    navigate(chooser.value, false); // Keep keyboard focus on the native quick switcher.
  });
  let waitingForDialog;
  function restoreFromHistory() {
    const route = routeFromUrl();
    if (route === current) return;
    const dialog = document.querySelector('dialog[open]');
    if (dialog) {
      // Keep the sheet, its draft and its scorecard together. Wait for the user
      // to close it (or for an in-flight save to finish); never submit or cancel here.
      if (!waitingForDialog) {
        waitingForDialog = new MutationObserver(() => {
          if (dialog.isConnected && dialog.hasAttribute('open')) return;
          waitingForDialog.disconnect();
          waitingForDialog = null;
          restoreFromHistory();
        });
        waitingForDialog.observe(dialog, { attributes: true, attributeFilter: ['open'] });
        waitingForDialog.observe(dialog.parentElement, { childList: true });
      }
      return;
    }
    show(route, true);
  }
  // Chrome may restore fragment focus after popstate. Read the latest URL and
  // focus its destination after traversal, not in the middle of the event.
  window.addEventListener('popstate', () => setTimeout(restoreFromHistory, 0));
}

mountAdminWorkspaces(document.querySelector('#adminContent'));
