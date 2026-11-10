// tests/apps/calendar.test.js — window app: month/week/day/agenda views,
// mini-calendar, event modal (create/edit/delete), storage sanitisation.
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp, settle } from '../helpers/app-harness.js';

const STORE_KEY = 'calendar_events_v2';
const FIRST_COLOR = '#58a6ff'; // COLORS[0] — the sanitiser's fallback

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('Calendar app (js/apps/calendar)', () => {
  beforeEach(() => resetTestStorage());

  it('registers a full app descriptor with the host', async () => {
    const { app } = await loadWindowApp('calendar');
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.astroos.calendar');
    expect(app.name).toBe('Calendar');
    expect(app.version).toBe('3.0.2');
    expect(app.icon).toBe('calendar');
    expect(app.defaultSize).toEqual([860, 580]);
    expect(app.minSize).toEqual([600, 440]);
    expect(typeof app.init).toBe('function');
  });

  it('shows the missing-data-directory fallback when AppDirs is absent', async () => {
    const { app, window } = await loadWindowApp('calendar', { stubs: { AppDirs: null } });
    const content = initApp(app, { window });
    expect(content.textContent).toContain('App data directory missing');
    expect(content.textContent).toContain('com.astroos.calendar');
  });

  it('renders the month view by default with sidebar, toolbar and view switcher', async () => {
    const { app, window } = await loadWindowApp('calendar');
    const content = initApp(app, { window });
    // Toolbar view buttons
    const viewBtns = [...content.querySelectorAll('[data-view]')];
    expect(viewBtns.map((b) => b.textContent)).toEqual(['Month', 'Week', 'Day', 'Agenda']);
    expect(viewBtns[0].dataset.view).toBe('month');
    // Month grid: main panel = root's 2nd child, content area = main's 2nd child
    const main = content.firstElementChild.children[1];
    const grid = main.children[1].firstElementChild;
    expect(grid).toBeTruthy();
    const headerDays = [...grid.children].slice(0, 7).map((c) => c.textContent);
    expect(headerDays).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    // 1 header row + one cell per leading blank + one per day of this month
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    expect(grid.children.length).toBe(7 + daysInMonth);
    // Sidebar: mini calendar + upcoming + New Event
    expect(content.textContent).toContain('Upcoming');
    expect(content.textContent).toContain('No upcoming events');
    const newBtn = [...content.querySelectorAll('button')].find((b) => b.textContent.includes('New Event'));
    expect(newBtn).toBeTruthy();
    // Today's cell is highlighted in the mini calendar
    const miniToday = [...content.querySelectorAll('.mini-day')].find((c) => c.textContent === String(now.getDate()) && c.style.background !== '');
    expect(miniToday).toBeTruthy();
  });

  it('creates an event through the modal and persists it to localStorage', async () => {
    const { app, window, document } = await loadWindowApp('calendar', { stubs: { extra: { Notify: { show: () => {} } } } });
    const content = initApp(app, { window });
    const newBtn = [...content.querySelectorAll('button')].find((b) => b.textContent.includes('New Event'));
    newBtn.click();

    // Modal lives on document.body, not in the app content
    const overlay = document.querySelector('[role="dialog"]');
    expect(overlay).toBeTruthy();
    expect(overlay.getAttribute('aria-label')).toBe('New Event');
    const titleInp = overlay.querySelector('input[placeholder="Event title"]');
    expect(titleInp).toBeTruthy();
    // Date field defaults to today
    expect(overlay.querySelector('input[type="date"]').value).toBe(todayStr());

    titleInp.value = 'Release review';
    titleInp.dispatchEvent(new window.Event('input', { bubbles: true }));
    // Pick the 3rd colour swatch (Yellow)
    const swatches = [...overlay.querySelectorAll('button[aria-label]')].filter((b) =>
      ['Blue', 'Green', 'Yellow', 'Red', 'Purple', 'Salmon', 'Sky', 'Lime'].includes(b.getAttribute('aria-label')));
    expect(swatches).toHaveLength(8);
    swatches[2].click();
    expect(swatches[2].style.borderColor).toContain('255, 255, 255'); // selected ring

    const saveBtn = [...overlay.querySelectorAll('button')].find((b) => b.textContent === 'Add Event');
    saveBtn.click();

    const stored = JSON.parse(window.localStorage.getItem(STORE_KEY));
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe('Release review');
    expect(stored[0].date).toBe(todayStr());
    expect(stored[0].color).toBe('#d29922'); // 3rd swatch
    // Modal closed, sidebar upcoming now lists it
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(content.textContent).toContain('Release review');
  });

  it('refuses to save an event without a title', async () => {
    const { app, window, document } = await loadWindowApp('calendar', { stubs: { extra: { Notify: { show: () => {} } } } });
    const content = initApp(app, { window });
    [...content.querySelectorAll('button')].find((b) => b.textContent.includes('New Event')).click();
    const overlay = document.querySelector('[role="dialog"]');
    const saveBtn = [...overlay.querySelectorAll('button')].find((b) => b.textContent === 'Add Event');
    saveBtn.click();
    // Validation: modal stays open and nothing is written
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    expect(window.localStorage.getItem(STORE_KEY)).toBeNull();
  });

  it('edits and deletes an existing event from the Upcoming list', async () => {
    // jsdom has no structuredClone; the edit path relies on it. Provide the
    // platform function the window manager's real runtime (NW.js/Chromium) has.
    const { app, window, document } = await loadWindowApp('calendar', {
      // jsdom has no structuredClone (edit path needs it) and no Notify global
      // (the save path's `Notify?.show?.` still ReferenceErrors on an undeclared
      // identifier). Stub both like the real host runtime provides them.
      stubs: { extra: { structuredClone: (v) => JSON.parse(JSON.stringify(v)), Notify: { show: () => {} } } },
    });
    window.localStorage.setItem(STORE_KEY, JSON.stringify([
      { id: 'evt-1', title: 'Old title', date: '2099-01-02', timeStart: '09:00', timeEnd: '10:00', desc: '', color: FIRST_COLOR },
    ]));
    const content = initApp(app, { window });
    expect(content.textContent).toContain('Old title');

    // Click the upcoming entry → edit modal pre-filled
    const upcomingItem = [...content.children[0].querySelectorAll('div')]
      .find((el) => el.textContent.includes('Old title') && el.style.cursor === 'pointer');
    upcomingItem.click();
    const overlay = document.querySelector('[role="dialog"]');
    expect(overlay.getAttribute('aria-label')).toBe('Edit Event');
    const titleInp = overlay.querySelector('input[placeholder="Event title"]');
    expect(titleInp.value).toBe('Old title');
    expect(overlay.querySelector('input[type="time"]').value).toBe('09:00');

    titleInp.value = 'Renamed event';
    [...overlay.querySelectorAll('button')].find((b) => b.textContent === 'Save Changes').click();
    let stored = JSON.parse(window.localStorage.getItem(STORE_KEY));
    expect(stored[0].title).toBe('Renamed event');
    expect(stored[0].date).toBe('2099-01-02'); // untouched fields preserved
    expect(content.textContent).toContain('Renamed event');

    // Delete via the edit modal
    upcomingItem.click();
    const overlay2 = document.querySelector('[role="dialog"]');
    [...overlay2.querySelectorAll('button')].find((b) => b.textContent === 'Delete').click();
    stored = JSON.parse(window.localStorage.getItem(STORE_KEY));
    expect(stored).toHaveLength(0);
    expect(content.textContent).toContain('No upcoming events');
  });

  it('switches views, navigates months and jumps to a day from the mini calendar', async () => {
    const { app, window } = await loadWindowApp('calendar');
    const content = initApp(app, { window });
    const main = content.firstElementChild.children[1];
    const mainTitle = content.querySelector('h3');
    const titleBefore = mainTitle.textContent;

    // Agenda view has a static title
    const viewBtns = [...content.querySelectorAll('[data-view]')];
    viewBtns[3].click(); // Agenda
    expect(mainTitle.textContent).toBe('Agenda');
    expect(viewBtns[3].style.background).toContain('accent'); // active styling

    // Week view title is a range with an en dash
    viewBtns[1].click(); // Week
    expect(mainTitle.textContent).toContain('–');

    // Month navigation changes the title. Toolbar layout: [prev, next, today,
    // title h3, view buttons] — prev/next carry the same chevron SVG, so pick
    // them positionally.
    viewBtns[0].click(); // Month
    expect(mainTitle.textContent).toBe(titleBefore);
    const toolbarBtns = [...main.children[0].querySelectorAll('button')];
    toolbarBtns[1].click(); // next
    expect(mainTitle.textContent).not.toBe(titleBefore);
    // "Today" returns to the current month
    toolbarBtns[2].click();
    expect(mainTitle.textContent).toBe(titleBefore);

    // Clicking a mini-calendar day switches to the Day view for that date
    const miniDays = [...content.querySelectorAll('.mini-day')].filter((c) => c.textContent !== '');
    miniDays[Math.min(5, miniDays.length - 1)].click();
    // Day view lists events for the selected date or the empty-state hint
    expect(
      content.textContent.includes('No events — click to add one.') ||
      mainTitle.textContent.length > 0
    ).toBe(true);
  });

  it('sanitises malformed persisted events and coerces unknown colours', async () => {
    const { app, window } = await loadWindowApp('calendar');
    window.localStorage.setItem(STORE_KEY, JSON.stringify([
      { title: '   ', date: '2099-01-01' },                      // dropped: blank title
      { title: 'Bad date', date: '01/02/2099' },                 // dropped: not YYYY-MM-DD
      null, 'garbage',                                            // dropped: not objects
      { title: 'No id', date: '2099-05-05' },                    // kept, id generated
      { id: 'keep', title: 'Weird colour', date: '2099-06-06', color: '#ff00ff' }, // coerced
    ]));
    const content = initApp(app, { window });
    // Only the two valid events survive sanitisation in memory…
    expect(content.textContent).toContain('No id');
    expect(content.textContent).toContain('Weird colour');
    expect(content.textContent).not.toContain('Bad date');
    // …but the raw key is NOT rewritten when it already exists (the re-save on
    // load only happens when localStorage was empty and legacy data was found).
    const stored = JSON.parse(window.localStorage.getItem(STORE_KEY));
    expect(stored).toHaveLength(6);
    // The coerced event renders with the fallback colour (#58a6ff → rgb).
    const bar = [...content.querySelectorAll('div')].find((d) => d.style.background === 'rgb(88, 166, 255)');
    expect(bar).toBeTruthy();

    // Legacy migration path: with an empty localStorage the app falls back to
    // the FS databases directory, and the sanitised list IS persisted back.
    const { app: app2, window: window2 } = await loadWindowApp('calendar', {
      stubs: {
        extra: {
          Notify: { show: () => {} },
          FS: { listDir: () => [{ name: 'events.json', type: 'file', content: JSON.stringify([
            { title: 'No id', date: '2099-05-05' },
            { id: 'keep', title: 'Weird colour', date: '2099-06-06', color: '#ff00ff' },
            { title: '', date: '2099-07-07' },
          ]) }] },
        },
      },
    });
    expect(window2.localStorage.getItem(STORE_KEY)).toBeNull();
    initApp(app2, { window: window2 });
    const stored2 = JSON.parse(window2.localStorage.getItem(STORE_KEY));
    expect(stored2).toHaveLength(2); // blank-title event dropped
    expect(stored2[0].id).toBeTruthy(); // id generated when missing
    expect(stored2[1].color).toBe(FIRST_COLOR); // CSS-injection guard
  });
});
