/**
 * Drives the booking flow rendered by Booker.astro.
 *
 * State lives in one object; each step renders from it. History entries are
 * pushed per step so the browser's Back button walks back through the flow
 * instead of leaving the page. Nothing a visitor types ever goes into the
 * URL or into storage.
 *
 * A booking starts on the calendar: a time, then the form. A topic is
 * optional and never a step; the rail beside the calendar on a wide screen
 * and the select in the form on a narrow one both set it. Times are shown on
 * the visitor's clock and, by default, only inside their own working hours
 * (`visitorHours` in config).
 */
import { clockLabel, fit, genericName, zoneLabel, zoneName, type Visitor, type ZoneSource } from '../lib/fit';
import { withinHours, type Hours } from '../lib/hours';
import { sketchPaths } from '../lib/sketch';
import { dateKey, isValidTimeZone, offsetMinutes, pad, wallClock } from '../lib/tz';
import { humanCheck } from './turnstile';

type RouteInfo = { id: string; label: string; response: string; minutes: number; prompt: string; placeholder: string };
type ManageInfo = { token: string; routeId: string; label: string; minutes: number; start: string; end: string; meetUrl?: string };
type Boot = {
  mode: 'book' | 'manage';
  initialRoute: string | null;
  hostTimeZone: string;
  visitorHours: Hours;
  meeting: { minutes: number; prompt: string; placeholder: string };
  routes: RouteInfo[];
  manage: ManageInfo | null;
  host: { firstName: string; email: string };
  turnstileSiteKey: string | null;
};
type Step = 'overview' | 'time' | 'details' | 'confirm' | 'note' | 'noted' | 'done' | 'cancelled';
type Confirmation = { start: string; end: string; meetUrl?: string; manageUrl: string };
type ApiError = { code: string; message: string };
type SlotsResponse = { ok: boolean; slots?: string[]; visitor?: Visitor; error?: ApiError };
type Slot = { at: Date; inside: boolean };

const root = document.querySelector<HTMLElement>('[data-booker]');
if (root) init(root);

function init(root: HTMLElement) {
  const boot: Boot = JSON.parse(root.querySelector('[data-boot]')!.textContent!);
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const $$ = <T extends Element = HTMLElement>(sel: string) => [...root.querySelectorAll<T>(sel)];
  const field = (sel: string) => root.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel);
  const errorMessage = (error: ApiError | undefined, fallback: string) =>
    error?.code === 'unavailable'
      ? `Booking is offline for a moment. You can email ${boot.host.email} instead.`
      : error?.message ?? fallback;

  // A name and email typed in the booking form are there in the note form, and back.
  function carry(from: 'f' | 'n', to: 'f' | 'n') {
    for (const key of ['name', 'email']) {
      const a = field(`#${from}-${key}`);
      const b = field(`#${to}-${key}`);
      if (a && b && a.value && !b.value) b.value = a.value;
    }
  }

  const deviceTz = (() => {
    try {
      const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return z && isValidTimeZone(z) ? z : null;
    } catch {
      return null;
    }
  })();

  const state = {
    // The server already rendered this step, so starting from it means the
    // first show() doesn't replay the entrance on a page that just loaded.
    step: (root.dataset.step ?? 'time') as Step,
    // The topic, if the visitor picked one.
    route: undefined as RouteInfo | undefined,
    tz: deviceTz ?? boot.hostTimeZone,
    tzSource: (deviceTz ? 'device' : 'host') as ZoneSource,
    visitor: null as Visitor | null,
    // Every time, not only those inside the visitor's hours.
    allHours: false,
    // Rescheduling a booking that was itself outside those hours.
    bookedOutside: false,
    slots: null as Date[] | null,
    slotsError: null as string | null,
    month: { y: 0, m: 0 },
    date: null as string | null,
    time: null as string | null,
    busy: false,
  };

  const wideQuery = window.matchMedia('(min-width: 860px)');
  const wide = () => wideQuery.matches;
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = () => window.matchMedia('(pointer: coarse)').matches;

  const live = $('[data-live]');
  const announce = (text: string) => {
    live.textContent = '';
    requestAnimationFrame(() => (live.textContent = text));
  };

  const turnstileEl = root.querySelector<HTMLElement>('[data-turnstile]');
  const human =
    boot.turnstileSiteKey && turnstileEl
      ? humanCheck(boot.turnstileSiteKey, turnstileEl, () =>
          announce('One more step: confirm you’re human with the checkbox above the Book button.')
        )
      : null;
  const noteTurnstileEl = root.querySelector<HTMLElement>('[data-turnstile-note]');
  const noteHuman =
    boot.turnstileSiteKey && noteTurnstileEl
      ? humanCheck(
          boot.turnstileSiteKey,
          noteTurnstileEl,
          () => announce('One more step: confirm you’re human with the checkbox above the Send button.'),
          'note'
        )
      : null;

  // ---- Formatting ------------------------------------------------------

  const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, { ...opts, timeZone: state.tz });
  const timeLabel = (d: Date) => fmt({ hour: 'numeric', minute: '2-digit' }).format(d);
  const dayLabel = (d: Date) => fmt({ weekday: 'long', month: 'long', day: 'numeric' }).format(d);
  const rangeLabel = (start: Date, end: Date) => `${timeLabel(start)} – ${timeLabel(end)}, ${dayLabel(start)}`;
  // A zone without a place: "Eastern Time".
  const zoneWord = (at: Date) => genericName(state.tz, at);
  const hoursFrom = clockLabel(boot.visitorHours.from, 0);
  const hoursTo = clockLabel(boot.visitorHours.to, 0);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const daysOpen = (n: number) => `${plural(n, 'day has', 'days have')} open times.`;

  // ---- Slots -----------------------------------------------------------

  // Open times depend only on a meeting's length, so every conversation of
  // the same length shares one lookup.
  const slotCache = new Map<string, Promise<SlotsResponse>>();
  const settled = new Map<string, SlotsResponse>();

  function fetchSlots(key: string, query: string) {
    let pending = slotCache.get(key);
    if (!pending) {
      pending = fetch(`/api/slots?${query}`, { headers: { accept: 'application/json' } })
        .then((r) => r.json() as Promise<SlotsResponse>)
        .catch(() => ({ ok: false, error: { code: 'network', message: 'Couldn’t reach the calendar. Check your connection and try again.' } }));
      slotCache.set(key, pending);
      pending.then((res) => {
        // A failed lookup shouldn't be cached forever.
        if (res.ok) settled.set(key, res);
        else slotCache.delete(key);
      });
    }
    return pending;
  }

  const slotQuery = () =>
    boot.manage
      ? { key: `manage`, query: `manage=${encodeURIComponent(boot.manage.token)}` }
      : { key: `m${minutes()}`, query: state.route ? `route=${encodeURIComponent(state.route.id)}` : '' };

  let wanted = '';
  async function loadSlots(fresh = false) {
    const { key, query } = slotQuery();
    wanted = key;
    if (fresh) {
      slotCache.delete(key);
      settled.delete(key);
    }
    const ready = settled.get(key);
    if (ready) return applySlots(ready);
    state.slots = null;
    state.slotsError = null;
    renderAll();
    const res = await fetchSlots(key, query);
    if (wanted !== key) return;
    applySlots(res);
  }

  function applySlots(res: SlotsResponse) {
    if (res.ok && res.slots) {
      state.slots = res.slots.map((s) => new Date(s));
      state.slotsError = null;
      // A time chosen from an older list, or for another length, only stands if it's still offered.
      if (state.time && !res.slots.includes(state.time)) state.time = null;
      if (res.visitor && !state.visitor) useVisitor(res.visitor);
    } else {
      state.slots = null;
      state.slotsError = errorMessage(res.error, 'Couldn’t load times.');
    }
    autoSelect();
    renderAll();
  }

  /** Cloudflare's guess at the visitor's zone. It only replaces the zone when the device gave none. */
  function useVisitor(v: Visitor) {
    if (!v.timeZone || !isValidTimeZone(v.timeZone)) return;
    state.visitor = { timeZone: v.timeZone };
    if (state.tzSource === 'host') {
      state.tz = v.timeZone;
      state.tzSource = 'ip';
      fillTimeZones();
    }
  }

  // The filter needs a zone to mean anything; with only the host's, show everything.
  // When nothing at all falls in the visitor's hours, show everything and say so.
  const filtering = () => state.tzSource !== 'host' && !state.allHours && !fullSchedule();
  const minutes = () => boot.manage?.minutes ?? state.route?.minutes ?? boot.meeting.minutes;

  let marks: { key: string; slots: Date[] | null; value: Slot[] } | null = null;
  function marked(): Slot[] {
    const key = `${state.tz}|${state.tzSource}|${minutes()}`;
    if (marks && marks.key === key && marks.slots === state.slots) return marks.value;
    const value = (state.slots ?? []).map((at) => ({
      at,
      inside: state.tzSource === 'host' || withinHours(at, minutes(), state.tz, boot.visitorHours),
    }));
    marks = { key, slots: state.slots, value };
    return value;
  }

  const visibleSlots = () => marked().filter((s) => s.inside || !filtering());

  function byDay(slots: Slot[]): Map<string, Slot[]> {
    const map = new Map<string, Slot[]>();
    for (const s of slots) {
      const key = dateKey(s.at, state.tz);
      const list = map.get(key);
      if (list) list.push(s);
      else map.set(key, [s]);
    }
    return map;
  }

  function counts() {
    const all = marked();
    const inside = all.filter((s) => s.inside).length;
    return { inside, outside: all.length - inside };
  }

  /** None of the open times fall inside the visitor's hours. */
  const fullSchedule = () => {
    if (!state.slots || state.tzSource === 'host') return false;
    const c = counts();
    return c.inside === 0 && c.outside > 0;
  };

  const openDays = () => byDay(visibleSlots()).size;

  /**
   * Keeps the chosen day if it still has times. A wide screen otherwise
   * opens on the first day with times, so they are there without a click.
   */
  function autoSelect() {
    const visible = byDay(visibleSlots());
    if (state.date && visible.has(state.date)) return;
    state.date = null;
    const first = visibleSlots()[0] ?? marked()[0];
    if (first) openMonthOf(first.at);
    if (state.step !== 'time' || !wide() || !visible.size) return;
    const [key] = visible.keys();
    state.date = key;
    state.month = monthOf(key);
  }

  function openMonthOf(at: Date) {
    const w = wallClock(at, state.tz);
    state.month = { y: w.year, m: w.month };
  }

  // ---- Steps -----------------------------------------------------------

  const order: Record<Step, number> = { overview: 0, time: 1, details: 2, confirm: 2, note: 2, noted: 3, done: 3, cancelled: 3 };
  const panels: Record<Step, string> = {
    overview: 'overview',
    time: 'schedule',
    details: 'schedule',
    confirm: 'schedule',
    note: 'schedule',
    noted: 'schedule',
    done: 'done',
    cancelled: 'cancelled',
  };

  const panelFor = (step: Step) => panels[step];

  function show(step: Step, { focus = true, push = true, animate = true } = {}) {
    const prevPanel = panelFor(state.step);
    root.dataset.dir = order[step] < order[state.step] ? 'back' : 'forward';
    state.step = step;
    root.dataset.step = step;

    for (const panel of $$('[data-step-panel]')) {
      const active = panel.dataset.stepPanel === panelFor(step);
      const wasHidden = panel.hidden;
      panel.hidden = !active;
      if (animate && active && (wasHidden || prevPanel !== panelFor(step))) enter(panel);
    }
    for (const pane of $$('[data-pane]')) {
      const name = pane.dataset.pane;
      const active = name === step;
      if (animate && active && pane.hidden) enter(pane);
      pane.hidden = !active;
    }

    if (state.slots) autoSelect();
    renderSummary();
    renderAll();
    if (step === 'details') {
      carry('n', 'f');
      human?.start();
    }
    if (step === 'note') {
      carry('f', 'n');
      noteHuman?.start();
    }
    if (push) pushHistory();
    if (focus) focusStep();
  }

  function enter(el: HTMLElement) {
    el.classList.remove('is-entering');
    void el.offsetWidth;
    el.classList.add('is-entering');
  }

  const shown = (el: Element | null) => !!el && el.getClientRects().length > 0;

  function focusStep() {
    let target: HTMLElement | null = null;
    if (state.step === 'details' || state.step === 'note') {
      // On a phone, the keyboard would cover what's above the form.
      const pane = `[data-pane="${state.step}"]`;
      target = coarse() ? $<HTMLElement>(`${pane} .pane-title`) : $<HTMLInputElement>(`${pane} input[name="name"]`);
    } else if (state.step === 'noted') {
      target = $<HTMLElement>('[data-pane="noted"] .pane-title');
    } else if (state.step === 'confirm') {
      target = $<HTMLElement>('[data-action="confirm-reschedule"]');
    } else if (state.step === 'time' && state.time && root.dataset.dir === 'back') {
      target = root.querySelector<HTMLElement>('.slot[data-selected] .slot-time');
    }
    if (!target) {
      const panel = root.querySelector(`[data-step-panel="${panelFor(state.step)}"]`);
      target = [...(panel?.querySelectorAll<HTMLElement>('h1') ?? [])].find(shown) ?? null;
    }
    target?.focus({ preventScroll: true });
    if (!wide()) window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' });
  }

  // ---- History ---------------------------------------------------------

  // The address names the topic, so a copied link opens the page as seen.
  const pathFor = () => (boot.mode === 'manage' ? location.pathname : state.route ? `/${state.route.id}` : '/');

  function pushHistory() {
    const entry = { step: state.step, date: state.date, time: state.time };
    const url = pathFor();
    if (state.step === 'done' || state.step === 'cancelled' || state.step === 'noted') history.replaceState(entry, '', url);
    else if (history.state?.step === entry.step) history.replaceState(entry, '', url);
    else history.pushState(entry, '', url);
  }

  window.addEventListener('popstate', (e) => {
    const s = e.state as { step: Step; date: string | null; time: string | null } | null;
    if (state.step === 'done' || state.step === 'cancelled') {
      // A finished booking shouldn't reopen its form. Start over instead.
      location.href = boot.mode === 'manage' ? location.pathname : '/';
      return;
    }
    if (!s) {
      if (boot.mode === 'book') show('time', { push: false });
      return;
    }
    // Back from the details lands on the calendar with that time still marked.
    const backToTime = s.step === 'time' && (state.step === 'details' || state.step === 'confirm');
    state.date = backToTime ? state.date ?? s.date : s.date;
    state.time = backToTime ? state.time : s.time;
    // A sent note isn't reopened; neither is a form whose time is gone.
    const step = ((s.step === 'details' || s.step === 'confirm') && !state.time) || s.step === 'noted' ? 'time' : s.step;
    show(step, { push: false });
    // The topic isn't part of history. It stays as the visitor left it, and the address follows.
    history.replaceState(history.state, '', pathFor());
  });

  wideQuery.addEventListener('change', () => show(state.step, { push: false, focus: false, animate: false }));

  // ---- Topic -----------------------------------------------------------
  // Optional, and never a step. The rail's buttons and the form's select both
  // set it, so either one shows what the other chose.

  const topicSelect = root.querySelector<HTMLSelectElement>('[data-topic-select]');
  const topicHint = root.querySelector<HTMLElement>('[data-topic-hint]');

  function setTopic(route: RouteInfo | undefined, { say = true } = {}) {
    const length = minutes();
    state.route = route;
    for (const button of $$('[data-topic]')) button.setAttribute('aria-pressed', String(button.dataset.topic === route?.id));
    if (topicSelect) topicSelect.value = route?.id ?? '';
    if (topicHint) {
      topicHint.textContent = route?.response ?? '';
      topicHint.hidden = !route;
    }
    const prompt = root.querySelector('[data-prompt]');
    if (prompt) prompt.textContent = route?.prompt ?? boot.meeting.prompt;
    const note = root.querySelector<HTMLTextAreaElement>('[data-note]');
    if (note) note.placeholder = route?.placeholder ?? boot.meeting.placeholder;
    history.replaceState(history.state, '', pathFor());
    if (minutes() !== length) refit(route, say);
    else if (say) announce(route ? `${route.label} selected.` : 'Topic cleared.');
  }

  /** A topic with a length of its own needs times that fit it. */
  async function refit(route: RouteInfo | undefined, say: boolean) {
    const n = minutes();
    const had = state.time;
    renderSummary();
    await loadSlots();
    // Changed again while the times loaded: the later change speaks for itself.
    if (state.route !== route) return;
    if (state.slotsError || (had && !state.time)) {
      const message = state.slotsError ?? `That time doesn’t fit a ${n}-minute conversation. Pick another.`;
      // The form is going away; if the focus was in it (the select, on a phone), it goes to the calendar.
      const held = !!form?.contains(document.activeElement);
      if (state.step === 'details') show('time', { focus: held });
      $('[data-cal-note]').textContent = message;
      announce(message);
      return;
    }
    if (say) announce(route ? `${route.label} is ${n} minutes, so I’m showing times that fit.` : `Topic cleared. Showing ${n}-minute times.`);
  }

  for (const button of $$<HTMLButtonElement>('[data-topic]')) {
    button.addEventListener('click', () => {
      const route = boot.routes.find((r) => r.id === button.dataset.topic);
      // Pressed again, it clears.
      setTopic(route && route.id === state.route?.id ? undefined : route);
    });
  }
  topicSelect?.addEventListener('change', () => setTopic(boot.routes.find((r) => r.id === topicSelect.value)));

  root.querySelector('[data-back]')?.addEventListener('click', () => {
    show(state.step === 'confirm' ? 'time' : 'overview');
  });

  root.querySelector('[data-change-time]')?.addEventListener('click', () => show('time'));

  // ---- Chosen time -----------------------------------------------------

  function renderSummary() {
    const chosen = state.time && (state.step === 'details' || state.step === 'confirm');
    const start = chosen ? new Date(state.time!) : null;
    const end = start ? new Date(start.getTime() + minutes() * 60_000) : null;

    // A booking shows the chosen time above the form; moving one shows it in the summary, beside the old time.
    if (start && end && root.querySelector('[data-when]')) {
      $('[data-when-text]').textContent = rangeLabel(start, end);
      // The zone's name alone: the offset can change before the meeting, when the clocks do.
      $('[data-when-sub]').textContent = zoneWord(start);
    }
    if (!boot.manage) return;
    $('[data-summary-when]').hidden = !start;
    if (start && end) $('[data-summary-when-text]').textContent = `${rangeLabel(start, end)} (${zoneWord(start)})`;
    $('[data-summary-was-text]').textContent = rangeLabel(new Date(boot.manage.start), new Date(boot.manage.end));
  }

  // ---- Fit: whose clock, which hours -----------------------------------

  const tzSelect = $<HTMLSelectElement>('[data-tz]');
  const fitBefore = $('[data-fit-before]');
  const fitAfter = $('[data-fit-after]');
  const fitActions = $('[data-fit-actions]');
  const hoursToggle = $<HTMLButtonElement>('[data-hours-toggle]');
  const notePrimary = root.querySelector<HTMLElement>('[data-note-primary]');
  const noteLine = root.querySelector<HTMLElement>('[data-note-line]');
  const correction = $('[data-fit-correction]');
  const useZone = $<HTMLButtonElement>('[data-fit-use]');
  const canNote = notePrimary !== null;
  let suggested: string | null = null;

  function renderFit() {
    const now = new Date();
    const f = fit({
      zone: state.tz,
      source: state.tzSource,
      deviceZone: deviceTz,
      visitor: state.visitor,
      hours: boot.visitorHours,
      allHours: state.allHours,
      bookedOutside: state.bookedOutside,
      counts: state.slots ? counts() : null,
      canNote,
      now,
    });
    const at = f.text.findIndex((p) => typeof p !== 'string');
    fitBefore.textContent = f.text.slice(0, at).join('');
    fitAfter.textContent = f.text.slice(at + 1).join('');
    $('[data-zone-label]').textContent = zoneName(state.tz, now);

    // With nothing in their hours, writing to Pavel is the main way on.
    const note = f.fullSchedule && canNote;
    fitActions.hidden = !f.toggle && !note;
    hoursToggle.hidden = !f.toggle;
    if (f.toggle) {
      // The same button flips both ways, so focus stays put when it's pressed.
      hoursToggle.textContent = f.toggle.label;
      hoursToggle.dataset.showAll = String(f.toggle.showAll);
    }
    if (notePrimary) notePrimary.hidden = !note;
    // Offered once there are times to turn down, and not twice.
    if (noteLine) noteLine.hidden = !state.slots || f.fullSchedule;

    correction.hidden = !f.correction;
    suggested = f.correction?.zone ?? null;
    if (f.correction) {
      $('[data-fit-suggest]').textContent = `Your connection suggests you might be on ${f.correction.label}.`;
      useZone.setAttribute('aria-label', `Switch to ${f.correction.label}`);
      useZone.textContent = 'Switch';
    }
  }

  function setAllHours(on: boolean) {
    state.allHours = on;
    if (!on) state.bookedOutside = false;
    const visible = new Set(visibleSlots().map((s) => s.at.toISOString()));
    if (state.time && !visible.has(state.time)) state.time = null;
    autoSelect();
    renderAll();
    announce(on ? `Showing every time. ${daysOpen(openDays())}` : `Showing times from ${hoursFrom} to ${hoursTo}. ${daysOpen(openDays())}`);
  }

  hoursToggle.addEventListener('click', () => setAllHours(hoursToggle.dataset.showAll === 'true'));
  root.querySelector('[data-hours-toggle-day]')?.addEventListener('click', () => {
    setAllHours(true);
    // The button goes with the filter; land on the first time it revealed.
    (root.querySelector<HTMLElement>('.slot-time:has(.slot-stamp)') ?? hoursToggle).focus();
  });
  useZone.addEventListener('click', () => {
    if (!suggested) return;
    setZone(suggested);
    tzSelect.focus();
  });

  function setZone(zone: string) {
    state.tz = zone;
    state.tzSource = 'chosen';
    tzSelect.value = zone;
    if (tzSelect.value !== zone) fillTimeZones();
    // On another clock the booking being moved may sit inside the visitor's hours after all.
    if (boot.manage && state.bookedOutside) {
      state.bookedOutside = !withinHours(new Date(boot.manage.start), boot.manage.minutes, zone, boot.visitorHours);
    }
    // The same instant can be a different date elsewhere, so the picked
    // day no longer means anything. Keep the time if it still shows.
    const visible = new Set(visibleSlots().map((s) => s.at.toISOString()));
    if (state.time && !visible.has(state.time)) state.time = null;
    state.date = state.time ? dateKey(new Date(state.time), state.tz) : null;
    autoSelect();
    renderSummary();
    renderAll();
    const label = zoneName(zone, new Date());
    announce(
      fullSchedule()
        ? `Time zone set to ${label}. None of my open times fall between ${hoursFrom} and ${hoursTo} there, so every time is showing.`
        : `Time zone set to ${label}. ${daysOpen(openDays())}`
    );
  }

  tzSelect.addEventListener('change', () => setZone(tzSelect.value));

  function fillTimeZones() {
    const now = new Date();
    let zones: string[];
    try {
      zones = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
    } catch {
      zones = [];
    }
    for (const z of [deviceTz, boot.hostTimeZone, state.tz, 'UTC']) if (z && !zones.includes(z)) zones.push(z);

    // The two pinned zones go by name; the full list needs cities to tell zones apart.
    const option = (z: string, label: string) => {
      const o = document.createElement('option');
      o.value = z;
      o.textContent = label;
      return o;
    };
    const group = (label: string, options: HTMLOptionElement[]) => {
      const g = document.createElement('optgroup');
      g.label = label;
      g.append(...options);
      return g;
    };
    const all = [...zones].sort((a, b) => offsetMinutes(now, a) - offsetMinutes(now, b) || a.localeCompare(b));
    const groups = [];
    if (deviceTz) groups.push(group('Your time zone', [option(deviceTz, zoneName(deviceTz, now))]));
    if (boot.hostTimeZone !== deviceTz) {
      groups.push(group(`${boot.host.firstName}’s time zone`, [option(boot.hostTimeZone, zoneName(boot.hostTimeZone, now))]));
    }
    groups.push(group('All time zones', all.map((z) => option(z, zoneLabel(z, now)))));
    tzSelect.replaceChildren(...groups);
    tzSelect.value = state.tz;
  }
  fillTimeZones();

  // ---- Calendar --------------------------------------------------------

  const ringFor = (seed: number) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'hand-ring');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of sketchPaths('circle', seed)) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(path);
    }
    requestAnimationFrame(() => requestAnimationFrame(() => svg.classList.add('is-drawn')));
    return svg;
  };

  const seedFor = (key: string) => Number(key.replace(/-/g, '')) % 9973;

  function monthBounds() {
    const now = new Date();
    const first = wallClock(now, state.tz);
    const last = state.slots?.length ? wallClock(state.slots[state.slots.length - 1], state.tz) : first;
    return { first: { y: first.year, m: first.month }, last: { y: last.year, m: last.month } };
  }

  const monthIndex = (p: { y: number; m: number }) => p.y * 12 + p.m;
  const monthOf = (key: string) => {
    const [y, m] = key.split('-').map(Number);
    return { y, m };
  };

  function renderAll() {
    renderFit();
    renderCalendar();
    renderTimes();
  }

  function renderCalendar() {
    if (!state.month.y) {
      const w = wallClock(new Date(), state.tz);
      state.month = { y: w.year, m: w.month };
    }
    const { y, m } = state.month;
    $('[data-month-label]').textContent = new Intl.DateTimeFormat(undefined, {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(y, m - 1, 1)));

    const bounds = monthBounds();
    $<HTMLButtonElement>('[data-month="-1"]').disabled = monthIndex(state.month) <= monthIndex(bounds.first);
    $<HTMLButtonElement>('[data-month="1"]').disabled = monthIndex(state.month) >= monthIndex(bounds.last);

    const grid = $('[data-days]');
    grid.replaceChildren();
    const days = byDay(marked());
    const today = dateKey(new Date(), state.tz);
    const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
    for (let i = 0; i < lead; i++) grid.appendChild(document.createElement('span'));

    let openThisMonth = 0;
    let hiddenOnly = 0;
    for (let d = 1; d <= count; d++) {
      const key = `${y}-${pad(m)}-${pad(d)}`;
      const all = days.get(key) ?? [];
      const times = filtering() ? all.filter((s) => s.inside) : all;
      const label = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(
        new Date(Date.UTC(y, m - 1, d))
      );
      const button = document.createElement('button');
      button.type = 'button';
      if (times.length) {
        openThisMonth++;
        button.dataset.day = key;
        button.setAttribute('aria-pressed', String(state.date === key));
        button.setAttribute('aria-label', `${label}, ${plural(times.length, 'open time', 'open times')}`);
        if (!times.some((s) => s.inside)) button.classList.add('is-outside');
        button.addEventListener('click', () => pickDate(key));
      } else {
        button.disabled = true;
        if (all.length) hiddenOnly++;
        button.setAttribute('aria-label', all.length ? `${label}, times only outside your hours` : `${label}, unavailable`);
      }
      button.classList.add('day');
      if (key === today) button.classList.add('is-today');
      button.append(String(d));
      if (state.date === key && times.length) button.appendChild(ringFor(seedFor(key)));
      grid.appendChild(button);
    }

    const note = $('[data-cal-note]');
    note.replaceChildren();
    if (state.slotsError) {
      note.textContent = state.slotsError;
    } else if (!state.slots) {
      note.textContent = `Checking ${boot.host.firstName}’s calendar…`;
    } else if (!state.slots.length) {
      note.append(`Nothing open in the next few weeks. Email `);
      const a = document.createElement('a');
      a.href = `mailto:${boot.host.email}`;
      a.className = 'link';
      a.textContent = boot.host.email;
      note.append(a, ' instead.');
    } else if (!openThisMonth) {
      const next = visibleSlots().find((s) => monthIndex(monthOf(dateKey(s.at, state.tz))) > monthIndex(state.month));
      if (next) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'link';
        b.textContent = `Jump to ${dayLabel(next.at)}`;
        b.addEventListener('click', () => {
          openMonthOf(next.at);
          pickDate(dateKey(next.at, state.tz));
        });
        note.append('No open times this month. ', b);
      }
    } else if (filtering() && hiddenOnly) {
      note.textContent = `${plural(hiddenOnly, 'more day this month has', 'more days this month have')} times only outside ${hoursFrom} to ${hoursTo}.`;
    }
  }

  for (const nav of $$<HTMLButtonElement>('[data-month]')) {
    nav.addEventListener('click', () => {
      const step = Number(nav.dataset.month);
      const idx = monthIndex(state.month) + step - 1;
      state.month = { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
      renderCalendar();
    });
  }

  // Arrow keys move between open days, so the grid isn't thirty tab stops.
  $('[data-days]').addEventListener('keydown', (e) => {
    const keys: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const delta = keys[e.key];
    const current = (e.target as HTMLElement).closest<HTMLElement>('[data-day]');
    if (!delta || !current) return;
    e.preventDefault();
    const days = $$<HTMLButtonElement>('[data-day]');
    const [cy, cm, cd] = current.dataset.day!.split('-').map(Number);
    const target = new Date(Date.UTC(cy, cm - 1, cd + delta));
    const key = `${target.getUTCFullYear()}-${pad(target.getUTCMonth() + 1)}-${pad(target.getUTCDate())}`;
    const exact = days.find((d) => d.dataset.day === key);
    const index = days.indexOf(current as HTMLButtonElement);
    const fallback = Math.abs(delta) === 1 ? days[index + delta] : undefined;
    (exact ?? fallback)?.focus();
  });

  function pickDate(key: string) {
    state.date = key;
    state.time = null;
    state.month = monthOf(key);
    renderCalendar();
    renderTimes();
    root.querySelector<HTMLElement>(`[data-day="${key}"]`)?.focus();
    const count = byDay(visibleSlots()).get(key)?.length ?? 0;
    announce(`${plural(count, 'open time', 'open times')}.`);
    // On a narrow screen the times are below the fold; bring them up.
    if (window.matchMedia('(max-width: 999px)').matches) {
      $('[data-times]').scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
    }
    pushHistory();
  }

  // ---- Times -----------------------------------------------------------

  /** Where an outside-hours time falls in the visitor's day, said in a word. */
  function stampFor(at: Date): string {
    const hour = wallClock(at, state.tz).hour;
    if (hour < 5) return 'night';
    return hour < boot.visitorHours.from ? 'early' : 'late';
  }

  function renderTimes() {
    const list = $('[data-times-list]');
    list.replaceChildren();
    const empty = $('[data-times-empty]');
    const more = $('[data-times-more]');
    more.hidden = true;
    $('[data-times-day]').textContent = '';

    const all = state.date ? byDay(marked()).get(state.date) ?? [] : [];
    const times = filtering() ? all.filter((s) => s.inside) : all;
    empty.hidden = times.length > 0;
    $('[data-times-day]').textContent = times.length ? dayLabel(times[0].at) : '';

    for (const { at, inside } of times) {
      const iso = at.toISOString();
      const li = document.createElement('li');
      li.className = 'slot';
      if (state.time === iso) li.dataset.selected = '';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'slot-time';
      button.append(timeLabel(at));
      if (!inside) {
        const stamp = document.createElement('span');
        stamp.className = 'slot-stamp';
        stamp.textContent = stampFor(at);
        button.append(' ', stamp);
      }
      button.addEventListener('click', () => {
        state.time = iso;
        const end = new Date(at.getTime() + minutes() * 60_000);
        show(boot.mode === 'manage' ? 'confirm' : 'details');
        announce(`${rangeLabel(at, end)}. ${boot.mode === 'manage' ? 'Confirm to move it.' : 'Enter your details to book.'}`);
      });

      li.append(button);
      list.appendChild(li);
    }

    const hidden = all.length - times.length;
    if (times.length && hidden) {
      more.hidden = false;
      $('[data-times-more-text]').textContent = `${plural(hidden, 'more time', 'more times')} outside ${hoursFrom} to ${hoursTo}.`;
    }
    list.scrollTop = 0;
    updateFade();
  }

  const timesList = $('[data-times-list]');
  function updateFade() {
    const scrollable = timesList.scrollHeight > timesList.clientHeight + 4;
    timesList.classList.toggle('is-scrollable', scrollable);
    timesList.classList.toggle('is-at-end', timesList.scrollTop + timesList.clientHeight >= timesList.scrollHeight - 4);
  }
  timesList.addEventListener('scroll', updateFade, { passive: true });
  window.addEventListener('resize', updateFade);

  // ---- Details (book) --------------------------------------------------

  const form = root.querySelector<HTMLFormElement>('[data-pane="details"]');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.busy || !state.time) return;
    const data = new FormData(form);
    const name = String(data.get('name') ?? '').trim();
    const email = String(data.get('email') ?? '').trim();

    const nameField = form.querySelector<HTMLInputElement>('#f-name')!;
    const emailField = form.querySelector<HTMLInputElement>('#f-email')!;
    if (!name) return formError('Enter your name.', nameField);
    if (!emailField.checkValidity() || !email) return formError('Enter a valid email address.', emailField);

    const result = await submit('/api/book', {
      routeId: state.route?.id,
      start: state.time,
      name,
      email,
      note: String(data.get('note') ?? ''),
      website: String(data.get('website') ?? ''),
      timeZone: state.tz,
    });
    if (result) renderDone(result as Confirmation, email);
  });

  function formError(message: string, field?: HTMLElement) {
    const el = root.querySelector<HTMLElement>(
      state.step === 'confirm' ? '[data-pane="confirm"] [data-form-error]' : '[data-pane="details"] [data-form-error]'
    );
    if (el) {
      el.textContent = message;
      el.hidden = false;
    }
    field?.focus();
    field?.setAttribute('aria-invalid', 'true');
  }

  function clearErrors() {
    for (const el of $$('[data-form-error]')) el.hidden = true;
    for (const el of $$('[aria-invalid]')) el.removeAttribute('aria-invalid');
  }

  async function submit(url: string, body: Record<string, unknown>): Promise<Confirmation | true | null> {
    clearErrors();
    const button = root.querySelector<HTMLButtonElement>(
      state.step === 'confirm' ? '[data-action="confirm-reschedule"]' : '[data-submit]'
    );
    const label = button?.textContent;
    const spam = state.step === 'details' ? human : null;
    state.busy = true;
    if (button) {
      button.setAttribute('aria-busy', 'true');
      button.textContent = state.step === 'confirm' ? 'Rescheduling…' : 'Booking…';
    }
    try {
      if (spam) {
        const turnstile = await spam.token();
        if (!turnstile) {
          formError(`The spam check didn’t finish. Try again in a moment, or email ${boot.host.email}.`);
          return null;
        }
        body = { ...body, turnstile };
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { ok: boolean; booking?: Confirmation; error?: ApiError };
      if (json.ok) return json.booking ?? true;

      if (json.error?.code === 'slot_taken') {
        // Someone got there first. Go back to the calendar with fresh times.
        state.time = null;
        show('time');
        await loadSlots(true);
        const note = $('[data-cal-note]');
        note.textContent = json.error.message;
        announce(json.error.message);
        return null;
      }
      formError(errorMessage(json.error, 'Something went wrong. Try again.'));
    } catch {
      formError(`Couldn’t reach the server. Check your connection, or email ${boot.host.email}.`);
    } finally {
      spam?.reset();
      state.busy = false;
      if (button) {
        button.removeAttribute('aria-busy');
        button.textContent = label ?? '';
      }
    }
    return null;
  }

  // ---- Note (book) -----------------------------------------------------
  // For a visitor none of the times suit: a few lines to Pavel's inbox.

  const noteForm = root.querySelector<HTMLFormElement>('[data-pane="note"]');
  // Its own flag: a note on its way mustn't block a booking, or the other way round.
  let noteBusy = false;

  for (const open of $$('[data-open-note]')) open.addEventListener('click', () => show('note'));
  for (const back of $$('[data-note-back]')) back.addEventListener('click', () => show('time'));

  noteForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (noteBusy) return;
    const error = $('[data-note-error]');
    const fail = (message: string, input?: HTMLElement | null) => {
      error.textContent = message;
      error.hidden = false;
      input?.focus();
      input?.setAttribute('aria-invalid', 'true');
    };
    error.hidden = true;
    for (const el of noteForm.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');

    const data = new FormData(noteForm);
    const name = String(data.get('name') ?? '').trim();
    const email = String(data.get('email') ?? '').trim();
    const text = String(data.get('text') ?? '').trim();
    const emailField = field('#n-email') as HTMLInputElement;
    if (!name) return fail('Enter your name.', field('#n-name'));
    if (!email || !emailField.checkValidity()) return fail('Enter a valid email address.', emailField);
    if (!text) return fail('Write a line about what would work for you.', field('#n-text'));

    const button = $<HTMLButtonElement>('[data-note-submit]');
    noteBusy = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Sending…';
    try {
      const turnstile = noteHuman ? await noteHuman.token() : '';
      if (noteHuman && !turnstile) return fail(`The spam check didn’t finish. Try again in a moment, or email ${boot.host.email}.`);
      const res = await fetch('/api/note', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          name,
          email,
          text,
          routeId: state.route?.id,
          timeZone: state.tz,
          website: String(data.get('website') ?? ''),
          turnstile,
        }),
      });
      const json = (await res.json()) as { ok: boolean; error?: ApiError };
      if (!json.ok) return fail(json.error?.message ?? 'Something went wrong. Try again.');
      (field('#n-text') as HTMLTextAreaElement).value = '';
      $('[data-noted-text]').textContent = `Thanks, ${name}. I’ll reply to ${email}.`;
      // Moved on while it sent: say so, but don't pull them back.
      if (state.step === 'note') show('noted');
      announce(state.step === 'noted' ? 'Note sent.' : `Your note to ${boot.host.firstName} was sent.`);
    } catch {
      fail(`Couldn’t reach the server. Check your connection, or email ${boot.host.email}.`);
    } finally {
      noteHuman?.reset();
      noteBusy = false;
      button.removeAttribute('aria-busy');
      button.textContent = 'Send note';
    }
  });

  // ---- Done ------------------------------------------------------------

  function renderDone(c: Confirmation, email?: string) {
    const start = new Date(c.start);
    const end = new Date(c.end);
    const rescheduled = boot.mode === 'manage';

    const date = $('[data-done-date]');
    const w = wallClock(start, state.tz);
    date.replaceChildren();
    const dow = document.createElement('span');
    dow.className = 'dow';
    dow.textContent = fmt({ weekday: 'short' }).format(start);
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(w.day);
    const mon = document.createElement('span');
    mon.className = 'dow';
    mon.textContent = fmt({ month: 'short' }).format(start);
    const stack = document.createElement('span');
    stack.style.display = 'grid';
    stack.append(dow, num, mon);
    date.append(stack, ringFor(seedFor(dateKey(start, state.tz))));

    $('[data-done-title]').textContent = rescheduled ? 'Moved.' : 'You’re booked.';
    $('[data-done-lede]').textContent = rescheduled
      ? `Google Calendar is sending you an updated invite. See you then.`
      : `A calendar invite with the Meet link is on its way to ${email}. See you then.`;

    const facts = $('[data-done-facts]');
    facts.replaceChildren();
    const fact = (label: string, value: string | Node, sub?: string) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.append(value);
      if (sub) {
        const s = document.createElement('span');
        s.className = 'sub';
        s.textContent = sub;
        dd.append(s);
      }
      facts.append(dt, dd);
    };
    const length = Math.round((end.getTime() - start.getTime()) / 60_000);
    fact('What', boot.manage?.label ?? state.route?.label ?? 'A conversation', `with ${boot.host.firstName}, ${length} min`);
    fact('When', rangeLabel(start, end), zoneWord(start));
    if (c.meetUrl) {
      const a = document.createElement('a');
      a.href = c.meetUrl;
      a.className = 'link';
      a.textContent = c.meetUrl.replace(/^https:\/\//, '');
      a.target = '_blank';
      a.rel = 'noopener';
      fact('Where', a, 'Google Meet');
    } else {
      fact('Where', 'Google Meet', 'The link is in your invite.');
    }

    const footer = $('[data-done-footer]');
    footer.replaceChildren();
    const manage = document.createElement('a');
    manage.href = c.manageUrl;
    manage.className = 'link';
    manage.textContent = 'Reschedule or cancel';
    footer.append('Plans change. ', manage, ' any time; the link is in your invite too.');

    show('done');
    announce(rescheduled ? 'Moved.' : 'You’re booked.');
  }

  // ---- Manage ----------------------------------------------------------

  if (boot.mode === 'manage' && boot.manage) {
    const m = boot.manage;
    // A guest who booked outside their usual hours has already said those hours work.
    if (state.tzSource !== 'host' && !withinHours(new Date(m.start), m.minutes, state.tz, boot.visitorHours)) {
      state.allHours = true;
      state.bookedOutside = true;
    }

    const facts = $('[data-overview-facts]');
    const renderOverview = () => {
      facts.replaceChildren();
      const add = (label: string, value: string | Node, sub?: string) => {
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.append(value);
        if (sub) {
          const s = document.createElement('span');
          s.className = 'sub';
          s.textContent = sub;
          dd.append(s);
        }
        facts.append(dt, dd);
      };
      add('What', m.label, `${m.minutes} min`);
      add('When', rangeLabel(new Date(m.start), new Date(m.end)), zoneWord(new Date(m.start)));
      if (m.meetUrl) {
        const a = document.createElement('a');
        a.href = m.meetUrl;
        a.className = 'link';
        a.textContent = m.meetUrl.replace(/^https:\/\//, '');
        add('Where', a, 'Google Meet');
      }
    };
    renderOverview();
    history.replaceState({ step: 'overview', date: null, time: null }, '', location.pathname);

    const confirmBox = $('[data-cancel-confirm]');
    const actions = $('[data-overview-actions]');
    const overviewError = $('[data-overview-error]');

    root.addEventListener('click', async (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
      if (!action) return;
      switch (action) {
        case 'reschedule':
          show('time');
          loadSlots();
          break;
        case 'ask-cancel':
          actions.hidden = true;
          confirmBox.hidden = false;
          confirmBox.querySelector<HTMLElement>('[data-action="cancel"]')?.focus();
          break;
        case 'keep':
          confirmBox.hidden = true;
          actions.hidden = false;
          actions.querySelector<HTMLElement>('[data-action="ask-cancel"]')?.focus();
          break;
        case 'cancel': {
          const button = e.target as HTMLButtonElement;
          button.setAttribute('aria-busy', 'true');
          button.textContent = 'Cancelling…';
          try {
            const res = await fetch('/api/manage', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ token: m.token, action: 'cancel' }),
            });
            const json = (await res.json()) as { ok: boolean; error?: ApiError };
            if (json.ok) {
              show('cancelled');
              announce('Cancelled.');
              return;
            }
            overviewError.textContent = errorMessage(json.error, 'Something went wrong.');
          } catch {
            overviewError.textContent = `Couldn’t reach the server. Email ${boot.host.email} instead.`;
          }
          overviewError.hidden = false;
          button.removeAttribute('aria-busy');
          button.textContent = 'Cancel conversation';
          break;
        }
        case 'back-to-time':
          show('time');
          break;
        case 'confirm-reschedule': {
          if (!state.time || state.busy) return;
          const result = await submit('/api/manage', { token: m.token, action: 'reschedule', start: state.time });
          if (result && result !== true) renderDone(result);
          break;
        }
      }
    });
  }

  // ---- Start -----------------------------------------------------------

  if (boot.mode === 'book') {
    history.replaceState({ step: 'time', date: null, time: null }, '', location.pathname);
    // Arrived on a topic's own link (/speaking): that topic is picked, and changing it is one click.
    const initial = boot.routes.find((r) => r.id === boot.initialRoute);
    if (initial) setTopic(initial, { say: false });
    show('time', { focus: false, push: false, animate: false });
    loadSlots();
  } else {
    renderFit();
  }
}
