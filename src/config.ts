/**
 * Everything Pavel is likely to want to change lives in this file: who is
 * being booked, when he is bookable, and the topics a visitor may pick from.
 *
 * Route copy is working copy in Pavel's voice. Edit freely — ids are what
 * the calendar events and URLs carry, so keep an id stable once people have
 * links to it.
 */

export const host = {
  name: 'Pavel Konoplenko',
  firstName: 'Pavel',
  site: 'https://pavelnovel.com',
  email: 'pkonopl@gmail.com',
  linkedin: 'https://www.linkedin.com/in/pavelnovel',
};

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** Wall-clock windows in the host's timezone, as `HH:MM`. */
export type Window = [start: string, end: string];

export type Availability = {
  /** IANA zone the weekly hours are written in. */
  timezone: string;
  weekly: Partial<Record<Weekday, Window[]>>;
  /** Slots start on this grid, in minutes, counted from each window's start. */
  stepMinutes: number;
  /** Clear time kept before and after every meeting, against any busy block. */
  bufferMinutes: number;
  /** Nothing bookable sooner than this from now. */
  minNoticeHours: number;
  /** Nothing bookable further out than this. */
  horizonDays: number;
  /** At most this many Schedulum bookings on one host-local day. */
  maxPerDay: number;
  /** Host-local dates (`YYYY-MM-DD`) that are never bookable. */
  blackoutDates: string[];
};

export const availability: Availability = {
  timezone: 'America/New_York',
  weekly: {
    mon: [['10:00', '17:00']],
    tue: [['10:00', '17:00']],
    wed: [['10:00', '17:00']],
    thu: [['10:00', '17:00']],
    fri: [['10:00', '15:00']],
  },
  stepMinutes: 30,
  bufferMinutes: 10,
  minNoticeHours: 12,
  horizonDays: 28,
  maxPerDay: 4,
  blackoutDates: [],
};

/**
 * The part of the visitor's own day offered by default, in whole hours on
 * their clock. A meeting must start and end inside it. The visitor can
 * always show every time.
 */
export const visitorHours = { from: 9, to: 19 };

/** Every conversation, unless a topic says otherwise. */
export const meeting = {
  minutes: 30,
  /** Asked at booking when the visitor picked no topic. */
  prompt: 'What’s on your mind?',
  placeholder: 'Anything that helps me show up prepared.',
};

/**
 * Things Pavel likes talking about. A visitor may pick one and never has to:
 * it sharpens the question asked at booking and tells Pavel what to expect.
 */
export type Route = {
  /** Stable, opaque, URL-safe. Lands in the URL and on the calendar event. */
  id: string;
  label: string;
  /** Two or three lines, first person, shown when the topic is picked. */
  response: string;
  /** Only when it differs from `meeting.minutes`. */
  minutes?: number;
  /** The one question asked at booking. Optional for the visitor. */
  prompt: string;
  placeholder: string;
};

export const opening = {
  title: 'Let’s find a time to talk',
  lede: `${meeting.minutes} minutes on Google Meet. You don’t need a reason to book, but if you have one, I’d like to hear it.`,
  topics: 'Potential topics',
};

export const routes: Route[] = [
  {
    id: 'ai-systems',
    label: 'Building useful AI systems',
    response:
      'For people past the demo stage. Bring the workflow you’re trying to automate and the part that keeps breaking. We’ll work out what a system your team can actually own would look like, and what to leave manual.',
    prompt: 'What are you building, and where is it stuck?',
    placeholder: 'A sentence or two is plenty.',
  },
  {
    id: 'ai-answers',
    label: 'How brands show up in AI answers',
    response:
      'ChatGPT, Claude, and Gemini are already describing your brand to buyers. We can look at what they say, why they say it, and what you can measure and change. It’s the problem I build Needlepick around.',
    prompt: 'Which brand, and what made you curious?',
    placeholder: 'Company or product, and what you’ve noticed.',
  },
  {
    id: 'managing-agents',
    label: 'Managing agents and AI-enabled teams',
    response:
      'Most AI work turns out to be management work: scoping, delegation, review, knowing when to stop. Bring a team or a workflow and we’ll talk about where the leverage really is.',
    prompt: 'What does your team look like today?',
    placeholder: 'Size, tools, and what you’re trying to hand off.',
  },
  {
    id: 'speaking',
    label: 'A talk, podcast, panel, or workshop',
    response:
      'Conference talks, podcasts, panels, and internal workshops. Tell me the audience and the format. Podcasts need no prep questions, and on a panel I’m happy to be the heretic.',
    prompt: 'The event or show, the date, and who’s in the audience.',
    placeholder: 'Name, rough date, audience.',
  },
];

export function findRoute(id: string | null | undefined): Route | undefined {
  return routes.find((route) => route.id === id);
}

export const minutesFor = (route?: Route) => route?.minutes ?? meeting.minutes;
