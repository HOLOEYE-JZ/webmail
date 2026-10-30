/**
 * Calendar events for booking cards: one JSCalendar event per transport leg
 * and one per hotel stay, rental car, event or table booking. Plain
 * TypeScript, no React and no stores, so the native app can reuse it.
 *
 * Times: a timed event starts at the departure's wall clock in its zone and
 * lasts the exact hours and minutes between the two UTC instants (never a
 * `D` duration, so a DST change in between can't move the end). The arrival
 * zone goes on the arrival location (`relativeTo: "end"`). Floating times
 * (no offset, no known zone) stay floating. Every event gets a uid derived
 * from the sender's organisational domain and the booking's identity, so a
 * later mail about the same booking finds it again and a mail from another
 * domain never can.
 */
import type { CalendarEvent, CalendarLocation } from '@/lib/jmap/types';
import { fixedOffsetZone, wallClockAt } from './time-zones';
import type {
  Address,
  Booking,
  Moment,
  Place,
  StructuredCard,
  TransportBooking,
  TransportLeg,
} from './types';

const DAY = 86_400_000;
const UID_DOMAIN = 'structured.bulwark';

// ---------------------------------------------------------------------------
// uid

/**
 * The organisational domain of a sender domain: its last two labels, or three
 * when the second-level label has at most three characters under a
 * two-letter TLD (`co.uk`, `com.au`). `booking.flixbus.com` → `flixbus.com`.
 */
export function organizationalDomain(fromDomain: string): string {
  const labels = fromDomain.trim().toLowerCase().replace(/\.+$/, '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  const count = tld.length === 2 && second.length <= 3 ? 3 : 2;
  return labels.slice(-count).join('.');
}

/** The domain part of an address (`orders@booking.flixbus.com` → `booking.flixbus.com`). */
export function senderDomainOf(address: string | undefined): string {
  if (!address) return '';
  const at = address.lastIndexOf('@');
  return (at >= 0 ? address.slice(at + 1) : address).trim().toLowerCase();
}

function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return bytes;
}

/**
 * 64-bit FNV-1a of the UTF-8 bytes, as 16 hex digits. Synchronous and on
 * plain numbers (four 16-bit limbs), so it runs without crypto.subtle (Lite
 * on plain http) and without BigInt.
 */
export function fnv1a64(text: string): string {
  // Offset basis 0xcbf29ce484222325, lowest limb first.
  let h0 = 0x2325, h1 = 0x8422, h2 = 0x9ce4, h3 = 0xcbf2;
  for (const byte of utf8Bytes(text)) {
    h0 ^= byte;
    // Multiply by the prime 0x100000001b3 = 2^40 + 0x1b3, modulo 2^64.
    let r0 = h0 * 0x1b3;
    let r1 = h1 * 0x1b3;
    let r2 = h2 * 0x1b3 + h0 * 0x100;
    let r3 = h3 * 0x1b3 + h1 * 0x100;
    r1 += r0 >>> 16; r0 &= 0xffff;
    r2 += r1 >>> 16; r1 &= 0xffff;
    r3 += r2 >>> 16; r2 &= 0xffff;
    r3 &= 0xffff;
    h0 = r0; h1 = r1; h2 = r2; h3 = r3;
  }
  return [h3, h2, h1, h0].map((limb) => limb.toString(16).padStart(4, '0')).join('');
}

const norm = (value: string | undefined) => (value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

function uidFrom(kind: Booking['kind'], parts: (string | undefined)[]): string {
  return `bulwark-sm-${kind}-${fnv1a64(parts.map(norm).join('|'))}@${UID_DOMAIN}`;
}

/**
 * The identity of a leg: carrier IATA code (the name only without one),
 * number and departure code or name, after the reference. Without a
 * reference the departure's local date is added. Never the time, so a
 * schedule change keeps the uid.
 */
function legParts(booking: TransportBooking, leg: TransportLeg, withDate: boolean): (string | undefined)[] {
  return [
    booking.reference,
    leg.carrierCode ?? leg.carrier,
    // "LX0072" in the markup is flight 72 on the boarding pass (legKey does the same).
    norm(leg.number).replace(/^0+(?=\d)/, ''),
    leg.departure.place.code ?? leg.departure.place.name,
    ...(withDate || !booking.reference ? [leg.departure.at.date] : []),
  ];
}

/**
 * The uid of the event for a booking (or, for flights, trains and buses, for
 * one of its legs; the first leg when none is given):
 * `bulwark-sm-<kind>-<16 hex>@structured.bulwark`, hashed over a key that
 * starts with the sender's organisational domain.
 */
export function bookingEventUid(booking: Booking, senderDomain: string, leg?: TransportLeg): string {
  return bookingUids(booking, senderDomain, leg ? [leg] : undefined)[0];
}

function bookingUids(booking: Booking, senderDomain: string, onlyLegs?: TransportLeg[]): string[] {
  const domain = organizationalDomain(senderDomainOf(senderDomain));
  switch (booking.kind) {
    case 'flight': case 'train': case 'bus': {
      // Two legs of one booking with the same carrier, number and departure
      // (the same commuter flight on two days) would share a uid: those get
      // their date as well.
      const keyOf = (leg: TransportLeg) => legParts(booking, leg, false).map(norm).join('|');
      const counts = new Map<string, number>();
      for (const leg of booking.legs) counts.set(keyOf(leg), (counts.get(keyOf(leg)) ?? 0) + 1);
      return (onlyLegs ?? booking.legs).map((leg) => {
        const clash = (counts.get(keyOf(leg)) ?? 0) > 1;
        return uidFrom(booking.kind, [domain, ...legParts(booking, leg, clash)]);
      });
    }
    case 'lodging':
      return [uidFrom('lodging', [domain, booking.reference, booking.name, ...(booking.reference ? [] : [booking.checkin.date])])];
    case 'rentalcar':
      return [uidFrom('rentalcar', [domain, booking.reference, booking.company ?? booking.provider, booking.pickup.at.date])];
    case 'event': case 'restaurant':
      return [uidFrom(booking.kind, [domain, booking.reference, booking.name, booking.start.date])];
  }
}

// ---------------------------------------------------------------------------
// times

interface Instant {
  /** Local wall clock, `YYYY-MM-DDTHH:mm:ss`, in `timeZone`. */
  start: string;
  /** IANA zone, or null for a floating time. */
  timeZone: string | null;
  /** UTC instant in ms; null when floating. */
  utcMs: number | null;
  /** The wall clock as the mail wrote it, read as if it were UTC (for floating differences). */
  naiveMs: number;
}

function naiveMs(m: Moment): number {
  return Date.parse(`${m.date}T${m.time ?? '00:00:00'}Z`);
}

/**
 * Where a timed moment sits: its resolved zone and instant. A moment that
 * resolveCards hasn't seen but that carries an offset gets the fixed-offset
 * zone; one without offset or zone stays floating.
 */
function instantOf(m: Moment | undefined): Instant | null {
  if (!m?.time || !/^\d{4}-\d{2}-\d{2}$/.test(m.date)) return null;
  const naive = naiveMs(m);
  if (!Number.isFinite(naive)) return null;
  const zone = m.zone !== undefined ? m.zone : (m.offsetMinutes !== undefined ? fixedOffsetZone(m.offsetMinutes) : null);
  if (zone === null) return { start: `${m.date}T${m.time}`, timeZone: null, utcMs: null, naiveMs: naive };
  const utcMs = m.utc ? Date.parse(m.utc) : NaN;
  if (!Number.isFinite(utcMs)) return null;
  const wall = wallClockAt(utcMs, zone);
  return { start: `${wall.date}T${wall.time}`, timeZone: zone, utcMs, naiveMs: naive };
}

/** Hours, minutes and seconds only (`PT7H15M`, `PT43H`, `PT0S`). */
function timedDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total <= 0) return 'PT0S';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}${s ? `${s}S` : ''}`;
}

/**
 * The exact span between two timed moments: from the UTC instants when both
 * have one, else from the wall clocks as written. Null when the end lies
 * before the start (resolveCards drops such bookings; this is a guard).
 */
function spanBetween(start: Instant, end: Instant): number | null {
  const ms = start.utcMs !== null && end.utcMs !== null ? end.utcMs - start.utcMs : end.naiveMs - start.naiveMs;
  return ms >= 0 ? ms : null;
}

function dayNumber(date: string): number | null {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / DAY) : null;
}

/** An all-day span from `first` to `last`, both days included. */
function allDaySpan(first: string, last: string): { start: string; duration: string } | null {
  const a = dayNumber(first);
  const b = dayNumber(last);
  if (a === null || b === null || b < a) return null;
  return { start: `${first}T00:00:00`, duration: `P${b - a + 1}D` };
}

/**
 * When a moment is over, in ms: its instant; a floating time read in the
 * runtime's zone; a date-only value at the end of that day (local).
 */
function momentOverAt(m: Moment | undefined): number | null {
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(m.date)) return null;
  if (m.time && m.utc) return Date.parse(m.utc);
  const [y, mo, d] = m.date.split('-').map(Number);
  if (m.time) {
    const [h, mi, s] = m.time.split(':').map(Number);
    return new Date(y, mo - 1, d, h, mi, s || 0).getTime();
  }
  return new Date(y, mo - 1, d + 1).getTime();
}

/**
 * When the booking is over (ms): the last arrival (or departure, for a leg
 * without arrival), check-out, drop-off, the event's end or start, the
 * table's time. Null when no date can be read.
 */
export function bookingEndsAt(booking: Booking): number | null {
  const ends: (number | null)[] = [];
  switch (booking.kind) {
    case 'flight': case 'train': case 'bus':
      for (const leg of booking.legs) ends.push(momentOverAt(leg.arrival?.at ?? leg.departure.at));
      break;
    case 'lodging': ends.push(momentOverAt(booking.checkout)); break;
    case 'rentalcar': ends.push(momentOverAt(booking.dropoff.at)); break;
    case 'event': ends.push(momentOverAt(booking.end ?? booking.start)); break;
    case 'restaurant': ends.push(momentOverAt(booking.start)); break;
  }
  const known = ends.filter((e): e is number => e !== null && Number.isFinite(e));
  return known.length > 0 ? Math.max(...known) : null;
}

// ---------------------------------------------------------------------------
// text

/** Description lines and the one title word that need the user's language. */
export interface BookingEventLabels {
  reference: (reference: string) => string;
  passengers: (names: string) => string;
  seats: (seats: string) => string;
  checkin: (url: string) => string;
  manage: (url: string) => string;
  ticket: (url: string) => string;
  phone: (phone: string) => string;
  car: (car: string) => string;
  tickets: (numbers: string) => string;
  partySize: (count: number) => string;
  rentalCar: (company: string | undefined) => string;
  addedFrom: (domain: string, subject: string | undefined) => string;
}

export const ENGLISH_LABELS: BookingEventLabels = {
  reference: (reference) => `Booking reference: ${reference}`,
  passengers: (names) => `Passengers: ${names}`,
  seats: (seats) => `Seats: ${seats}`,
  checkin: (url) => `Check in: ${url}`,
  manage: (url) => `Manage booking: ${url}`,
  ticket: (url) => `Ticket: ${url}`,
  phone: (phone) => `Phone: ${phone}`,
  car: (car) => `Car: ${car}`,
  tickets: (numbers) => `Tickets: ${numbers}`,
  partySize: (count) => `Party size: ${count}`,
  rentalCar: (company) => (company ? `Rental car: ${company}` : 'Rental car'),
  addedFrom: (domain, subject) => (subject ? `Added from the mail "${subject}" from ${domain}` : `Added from a mail from ${domain}`),
};

function addressLines(address: Address | undefined): string[] {
  if (!address) return [];
  const city = [address.postalCode, address.locality].filter(Boolean).join(' ');
  return [address.street, city].filter((line): line is string => !!line && line.trim() !== '');
}

/** "Name, Street 1, 12345 City", skipping parts that repeat. */
function joinParts(parts: (string | undefined)[]): string {
  const out: string[] = [];
  for (const part of parts) {
    const value = part?.trim();
    if (value && !out.some((p) => p.toLowerCase() === value.toLowerCase())) out.push(value);
  }
  return out.join(', ');
}

/** "Frankfurt Airport (FRA)" for airports, name and address elsewhere. */
function placeName(place: Place | undefined, kind: Booking['kind']): string {
  if (!place) return '';
  if (kind === 'flight') {
    if (place.name && place.code) return place.name.toUpperCase().includes(`(${place.code})`) ? place.name : `${place.name} (${place.code})`;
    return place.code ?? place.name ?? '';
  }
  return joinParts([place.name, ...addressLines(place.address)]);
}

function shortPlace(place: Place | undefined, kind: Booking['kind']): string {
  if (!place) return '';
  return (kind === 'flight' ? place.code ?? place.name : place.name ?? place.code) ?? '';
}

function legTitle(kind: TransportBooking['kind'], leg: TransportLeg): string {
  let service: string;
  if (kind === 'flight') {
    service = [leg.carrierCode ?? leg.carrier, leg.number].filter(Boolean).join(' ');
  } else if (leg.number && /[a-z]/i.test(leg.number)) {
    service = leg.number;
  } else {
    service = [leg.carrier, leg.number].filter(Boolean).join(' ');
  }
  const route = [shortPlace(leg.departure.place, kind), shortPlace(leg.arrival?.place, kind)].filter(Boolean).join(' → ');
  return [service, route].filter(Boolean).join(' ');
}

function passengerLines(booking: Booking, leg: TransportLeg | undefined, labels: BookingEventLabels): string[] {
  const seats = leg?.seats ?? [];
  const seatsOf = (name: string) => seats.filter((s) => s.passenger === name).map((s) => s.seat);
  const names = booking.passengers.map((name) => {
    const own = seatsOf(name);
    return own.length > 0 ? `${name} (${own.join(', ')})` : name;
  });
  const unnamed = seats.filter((s) => !s.passenger || !booking.passengers.includes(s.passenger)).map((s) => s.seat);
  const lines: string[] = [];
  if (names.length > 0) lines.push(labels.passengers(names.join(', ')));
  if (unnamed.length > 0) lines.push(labels.seats(unnamed.join(', ')));
  return lines;
}

function linkLines(booking: Booking, labels: BookingEventLabels): string[] {
  const lines: string[] = [];
  if (booking.links.checkin) lines.push(labels.checkin(booking.links.checkin.url));
  if (booking.links.manage) lines.push(labels.manage(booking.links.manage.url));
  if (booking.links.ticket) lines.push(labels.ticket(booking.links.ticket.url));
  return lines;
}

// ---------------------------------------------------------------------------
// events

export interface BookingEventOptions {
  /** Domain (or address) of the mail's From: names the sender and keys the uid. */
  senderDomain: string;
  /** Subject of the mail, named in the description so the user can find it. */
  mailSubjectOrProvider?: string;
  /** Translated description lines; English by default. */
  labels?: Partial<BookingEventLabels>;
}

/** One event the booking wants in the calendar, or, for a cancelled leg, one it wants gone. */
export interface BookingEventSlot {
  uid: string;
  /** The leg or booking is cancelled: never added, removed when present. */
  cancelled: boolean;
  /** The event to create or compare with; null when the times can't be made into one. */
  event: Partial<CalendarEvent> | null;
}

type Locations = Record<string, CalendarLocation>;

function location(name: string, timeZone: string | null | undefined, relativeTo?: 'start' | 'end'): CalendarLocation {
  return {
    '@type': 'Location',
    name,
    ...(timeZone ? { timeZone } : {}),
    ...(relativeTo ? { relativeTo } : {}),
  } as CalendarLocation;
}

function event(
  uid: string,
  title: string,
  when: { start: string; timeZone: string | null; duration: string; showWithoutTime: boolean },
  locations: Locations,
  description: string[],
  extra: Partial<CalendarEvent> = {},
): Partial<CalendarEvent> {
  return {
    '@type': 'Event',
    uid,
    title,
    start: when.start,
    timeZone: when.timeZone,
    duration: when.duration,
    showWithoutTime: when.showWithoutTime,
    ...(Object.keys(locations).length > 0 ? { locations } : {}),
    description: description.filter(Boolean).join('\n'),
    ...extra,
  };
}

/** A timed span from `from` to `to` (or zero length without `to`), or null when it can't be told exactly. */
function timedSpan(from: Moment, to: Moment | undefined) {
  const start = instantOf(from);
  if (!start) return null;
  if (!to) return { start, end: null, when: { start: start.start, timeZone: start.timeZone, duration: 'PT0S', showWithoutTime: false } };
  const end = instantOf(to);
  if (!end) return null;
  const ms = spanBetween(start, end);
  if (ms === null) return null;
  return { start, end, when: { start: start.start, timeZone: start.timeZone, duration: timedDuration(ms), showWithoutTime: false } };
}

function legEvent(booking: TransportBooking, leg: TransportLeg, uid: string, tail: string[], labels: BookingEventLabels): Partial<CalendarEvent> | null {
  const span = timedSpan(leg.departure.at, leg.arrival?.at);
  if (!span) return null;
  const locations: Locations = {
    dep: location(placeName(leg.departure.place, booking.kind), span.start.timeZone, 'start'),
  };
  if (leg.arrival && placeName(leg.arrival.place, booking.kind)) {
    locations.arr = location(placeName(leg.arrival.place, booking.kind), span.end?.timeZone, 'end');
  }
  return event(uid, legTitle(booking.kind, leg), span.when, locations, [
    booking.reference ? labels.reference(booking.reference) : '',
    ...passengerLines(booking, leg, labels),
    ...linkLines(booking, labels),
    ...tail,
  ]);
}

function slotsOf(booking: Booking, options: BookingEventOptions): BookingEventSlot[] {
  const labels: BookingEventLabels = { ...ENGLISH_LABELS, ...options.labels };
  const domain = organizationalDomain(senderDomainOf(options.senderDomain));
  const tail = [labels.addedFrom(domain, options.mailSubjectOrProvider?.trim() || undefined)];
  const reference = booking.reference ? labels.reference(booking.reference) : '';
  const cancelled = booking.status === 'cancelled';

  switch (booking.kind) {
    case 'flight': case 'train': case 'bus': {
      const uids = bookingUids(booking, options.senderDomain);
      return booking.legs.map((leg, i) => ({
        uid: uids[i],
        cancelled: cancelled || leg.status === 'cancelled',
        event: legEvent(booking, leg, uids[i], tail, labels),
      }));
    }
    case 'lodging': {
      const [uid] = bookingUids(booking, options.senderDomain);
      const hotel = joinParts([booking.name, ...addressLines(booking.address)]);
      const description = [
        reference,
        ...passengerLines(booking, undefined, labels),
        booking.phone ? labels.phone(booking.phone) : '',
        ...linkLines(booking, labels),
        ...tail,
      ];
      const timed = booking.checkin.time && booking.checkout.time ? timedSpan(booking.checkin, booking.checkout) : null;
      if (timed) {
        return [{
          uid, cancelled,
          event: event(uid, booking.name, timed.when, { hotel: location(hotel, timed.start.timeZone) }, description, { freeBusyStatus: 'free' }),
        }];
      }
      const days = allDaySpan(booking.checkin.date, booking.checkout.date);
      return [{
        uid, cancelled,
        event: days
          ? event(uid, booking.name, { ...days, timeZone: null, showWithoutTime: true }, { hotel: location(hotel, null) }, description, { freeBusyStatus: 'free' })
          : null,
      }];
    }
    case 'rentalcar': {
      const [uid] = bookingUids(booking, options.senderDomain);
      const span = timedSpan(booking.pickup.at, booking.dropoff.at);
      const locations: Locations = {};
      if (span) {
        const pickup = placeName(booking.pickup.place, booking.kind);
        const dropoff = placeName(booking.dropoff.place, booking.kind);
        if (pickup) locations.pickup = location(pickup, span.start.timeZone, 'start');
        if (dropoff) locations.dropoff = location(dropoff, span.end?.timeZone, 'end');
      }
      return [{
        uid, cancelled,
        event: span
          ? event(uid, labels.rentalCar(booking.company ?? booking.provider), span.when, locations, [
            reference,
            booking.car ? labels.car(booking.car) : '',
            ...linkLines(booking, labels),
            ...tail,
          ], { freeBusyStatus: 'free' })
          : null,
      }];
    }
    case 'event': {
      const [uid] = bookingUids(booking, options.senderDomain);
      const description = [
        reference,
        booking.tickets.length > 0 ? labels.tickets(booking.tickets.join(', ')) : '',
        ...linkLines(booking, labels),
        ...tail,
      ];
      let made: Partial<CalendarEvent> | null = null;
      if (booking.start.time) {
        // An end date without time already became 23:59:59 in the parser; no
        // end at all is zero length (Stalwart would stretch a missing
        // duration to the end of the day).
        const span = timedSpan(booking.start, booking.end);
        const venue = placeName(booking.venue, booking.kind);
        if (span) made = event(uid, booking.name, span.when, venue ? { venue: location(venue, span.start.timeZone) } : {}, description);
      } else {
        const days = allDaySpan(booking.start.date, booking.end?.date ?? booking.start.date);
        const venue = placeName(booking.venue, booking.kind);
        if (days) made = event(uid, booking.name, { ...days, timeZone: null, showWithoutTime: true }, venue ? { venue: location(venue, null) } : {}, description);
      }
      return [{ uid, cancelled, event: made }];
    }
    case 'restaurant': {
      const [uid] = bookingUids(booking, options.senderDomain);
      const span = timedSpan(booking.start, undefined);
      const place = joinParts([booking.name, ...addressLines(booking.address)]);
      return [{
        uid, cancelled,
        event: span
          ? event(uid, booking.name, span.when, { restaurant: location(place, span.start.timeZone) }, [
            reference,
            booking.partySize ? labels.partySize(booking.partySize) : '',
            ...linkLines(booking, labels),
            ...tail,
          ])
          : null,
      }];
    }
  }
}

/**
 * Every event a booking stands for, cancelled ones included (the caller
 * offers to remove those). Nothing for shipments.
 */
export function bookingEventSlots(card: StructuredCard, options: BookingEventOptions): BookingEventSlot[] {
  if (card.kind === 'shipment') return [];
  return slotsOf(card, options);
}

/**
 * The events to add for a booking: one per live leg, or one for the stay,
 * car, event or table. Cancelled legs give none. No calendarIds (the caller
 * picks the calendar), no participants, never scheduling messages.
 */
export function bookingToEvents(booking: Booking, options: BookingEventOptions): Partial<CalendarEvent>[] {
  return slotsOf(booking, options)
    .filter((slot) => !slot.cancelled && slot.event)
    .map((slot) => slot.event as Partial<CalendarEvent>);
}

// ---------------------------------------------------------------------------
// comparing with what the calendar holds

const DURATION = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** Nominal days and exact seconds of a duration; P1D and PT24H differ. */
function durationParts(value: string | undefined | null): string {
  const match = value ? DURATION.exec(value) : null;
  if (!match) return value ?? '';
  const days = Number(match[1] ?? 0) * 7 + Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0) * 3600 + Number(match[4] ?? 0) * 60 + Number(match[5] ?? 0);
  return `${days}d${seconds}s`;
}

const localDateTime = (value: string | undefined | null) => {
  const v = value ?? '';
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? `${v}:00` : v.slice(0, 19);
};

/** Location ids this module writes; other locations on the event are the user's. */
const OWN_LOCATION_IDS = ['dep', 'arr', 'hotel', 'pickup', 'dropoff', 'venue', 'restaurant'];

/**
 * Whether the stored event differs from the one the booking now gives, in
 * what matters for where it sits: start, duration, time zone, title, all-day
 * flag and the name, zone and anchor of each location this module writes.
 * Field by field, because the server adds defaults (`iCalendar`, nulls).
 */
export function eventNeedsUpdate(existing: Partial<CalendarEvent>, wanted: Partial<CalendarEvent>): boolean {
  if (localDateTime(existing.start) !== localDateTime(wanted.start)) return true;
  if (durationParts(existing.duration) !== durationParts(wanted.duration ?? 'PT0S')) return true;
  if ((existing.timeZone ?? null) !== (wanted.timeZone ?? null)) return true;
  if ((existing.title ?? '') !== (wanted.title ?? '')) return true;
  if (Boolean(existing.showWithoutTime) !== Boolean(wanted.showWithoutTime)) return true;
  const have = existing.locations ?? {};
  const want = wanted.locations ?? {};
  for (const id of OWN_LOCATION_IDS) {
    const a = have[id];
    const b = want[id];
    if (!a && !b) continue;
    if (!a || !b) return true;
    if ((a.name ?? '') !== (b.name ?? '')) return true;
    if ((a.timeZone ?? null) !== (b.timeZone ?? null)) return true;
    if ((a.relativeTo ?? null) !== (b.relativeTo ?? null)) return true;
  }
  return false;
}

/**
 * The patch that brings a stored event to the booking's current state. The
 * user's own locations stay; ours are replaced.
 */
export function bookingEventPatch(existing: Partial<CalendarEvent>, wanted: Partial<CalendarEvent>): Partial<CalendarEvent> {
  const locations: Locations = {};
  for (const [id, loc] of Object.entries(existing.locations ?? {})) {
    if (!OWN_LOCATION_IDS.includes(id)) locations[id] = loc;
  }
  Object.assign(locations, wanted.locations ?? {});
  return {
    title: wanted.title,
    start: wanted.start,
    timeZone: wanted.timeZone ?? null,
    duration: wanted.duration,
    showWithoutTime: Boolean(wanted.showWithoutTime),
    locations: Object.keys(locations).length > 0 ? locations : null,
    ...(wanted.description !== undefined ? { description: wanted.description } : {}),
    ...(wanted.freeBusyStatus ? { freeBusyStatus: wanted.freeBusyStatus } : {}),
  };
}
