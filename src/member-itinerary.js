import { formatHomeDate, formatItineraryTime, groupPublicSchedule } from './home.js?v=itinerary-1';

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

function eventCard(event) {
  const card = node('article', 'itinerary-card');
  const timed = event.time_precision !== 'tbd';
  const time = node(timed ? 'time' : 'span', 'itinerary-time',
    formatItineraryTime(event.starts_at, event.ends_at, event.time_precision));
  if (timed) time.dateTime = event.starts_at;

  const details = node('div', 'itinerary-details');
  details.append(node('strong', '', event.title));
  const type = event.event_type?.replace(/^./, first => first.toUpperCase());
  const context = [type, event.courses?.name].filter(Boolean).join(' · ');
  if (context) details.append(node('span', '', context));
  if (event.public_details) details.append(node('span', '', event.public_details));
  if (event.notes && event.notes !== event.public_details) details.append(node('span', '', event.notes));

  card.append(time, details, node('span', event.is_competitive ? 'event-badge competitive' : 'event-badge',
    event.is_competitive ? 'Cup event' : 'Itinerary'));
  return card;
}

export function renderMemberItinerary(container, events) {
  // Reuse the public schedule's tournament-timezone grouping, not its data feed.
  const days = groupPublicSchedule({ events: events.map(event => ({ ...event, startsAt: event.starts_at })) });
  if (!days.length) {
    container.replaceChildren(node('p', 'empty-panel', 'The itinerary has not been published yet.'));
    return;
  }

  const tablist = node('div', 'session-tabs');
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', 'Itinerary days');
  const panels = days.map(({ date, items }, index) => {
    const tab = node('button');
    tab.type = 'button';
    tab.id = `member-day-${date}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `${tab.id}-panel`);
    tab.append(node('span', '', `DAY ${index + 1}`), document.createTextNode(formatHomeDate(date, { weekday: 'short' })));
    tab.addEventListener('click', () => select(index));
    tab.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      let next;
      switch (event.key) {
        case 'ArrowRight': next = (index + 1) % days.length; break;
        case 'ArrowLeft': next = (index + days.length - 1) % days.length; break;
        case 'Home': next = 0; break;
        case 'End': next = days.length - 1; break;
        default: return;
      }
      event.preventDefault();
      select(next);
      tablist.children[next].focus();
    });
    tablist.append(tab);

    const panel = node('div');
    panel.id = `${tab.id}-panel`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.tabIndex = 0;
    const cards = node('div', 'match-list');
    cards.append(...items.map(({ data }) => eventCard(data)));
    panel.append(cards);
    return panel;
  });

  function select(index) {
    panels.forEach((panel, i) => {
      const tab = tablist.children[i];
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panel.hidden = i !== index;
    });
  }
  select(0);
  container.replaceChildren(tablist, ...panels);
}
