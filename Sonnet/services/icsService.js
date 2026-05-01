// services/icsService.js
// Minimal RFC 5545 ICS string generator + Google Calendar template URL builder.
// Hand-rolled to avoid adding a new dependency — the ICS surface we need is tiny
// and the only output target is mainstream calendar clients (Apple Calendar,
// Google Calendar, Outlook 365). Note: we intentionally do NOT enforce the
// 75-octet line-fold rule from RFC 5545 §3.1 — modern clients tolerate long
// lines and our content fields rarely exceed it. Revisit only if a real client
// rejects an attachment.

/**
 * Format a Date as an ICS UTC timestamp: YYYYMMDDTHHMMSSZ
 * @param {Date} d
 * @returns {string}
 */
function formatIcsDate(d) {
  // toISOString → 2026-06-01T18:00:00.000Z → 20260601T180000Z
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Escape a string for ICS TEXT values per RFC 5545 §3.3.11.
 * Order matters: backslash MUST be escaped first, otherwise we'd double-escape
 * the backslashes we introduce when escaping the other characters.
 * @param {string} s
 * @returns {string}
 */
function escapeIcsText(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\n');
}

/**
 * Build a minimal valid VCALENDAR/VEVENT string for an event.
 * @param {Object} params
 * @param {string} params.eventId - Stable event identifier (UUID)
 * @param {string} params.gameName
 * @param {string} params.groupName
 * @param {Date}   params.startUtc - Event start as a JS Date (UTC interpretation)
 * @param {number} params.durationMinutes
 * @param {string} [params.location]
 * @param {string} [params.description]
 * @param {string} [params.hostName]
 * @param {string} [params.organizerEmail]
 * @returns {string} ICS string with CRLF line endings
 */
function buildEventIcs({
  eventId,
  gameName,
  groupName,
  startUtc,
  durationMinutes,
  location,
  description,
  hostName,
  organizerEmail,
}) {
  const start = startUtc instanceof Date ? startUtc : new Date(startUtc);
  const end = new Date(start.getTime() + (Number(durationMinutes) || 0) * 60000);
  const stamp = formatIcsDate(new Date());

  const summary = `${gameName || 'Game Night'} — ${groupName || ''}`.trim();
  const desc =
    description || `Game night with ${groupName || 'your group'} on Nextgamenight.`;
  const organizer = organizerEmail || 'schedule@nextgamenight.app';
  const cn = hostName || groupName || 'NextGameNight';

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//NextGameNight//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:event-${eventId}@nextgamenight.app`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${formatIcsDate(start)}`,
    `DTEND:${formatIcsDate(end)}`,
    `SUMMARY:${escapeIcsText(summary)}`,
  ];

  if (location && String(location).trim() !== '') {
    lines.push(`LOCATION:${escapeIcsText(location)}`);
  }

  lines.push(`DESCRIPTION:${escapeIcsText(desc)}`);
  lines.push(`ORGANIZER;CN=${escapeIcsText(cn)}:mailto:${organizer}`);
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');

  // RFC 5545 mandates CRLF line endings
  return lines.join('\r\n') + '\r\n';
}

/**
 * Build a Google Calendar "create event" template URL.
 * Recipients click this and land in a pre-filled new-event dialog.
 * @param {Object} params
 * @param {string} params.gameName
 * @param {string} params.groupName
 * @param {Date}   params.startUtc
 * @param {number} params.durationMinutes
 * @param {string} [params.location]
 * @param {string} [params.description]
 * @returns {string} https://calendar.google.com/... URL
 */
function buildGoogleCalendarUrl({
  gameName,
  groupName,
  startUtc,
  durationMinutes,
  location,
  description,
}) {
  const start = startUtc instanceof Date ? startUtc : new Date(startUtc);
  const end = new Date(start.getTime() + (Number(durationMinutes) || 0) * 60000);

  const text = `${gameName || 'Game Night'} — ${groupName || ''}`.trim();
  const dates = `${formatIcsDate(start)}/${formatIcsDate(end)}`;

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text,
    dates,
  });
  if (description) params.set('details', description);
  if (location) params.set('location', location);

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

module.exports = {
  buildEventIcs,
  buildGoogleCalendarUrl,
  // Exposed for unit tests; not part of the public surface.
  _internals: { formatIcsDate, escapeIcsText },
};
