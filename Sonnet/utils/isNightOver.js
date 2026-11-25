// utils/isNightOver.js
//
// DECISION Phase 89.6-28 (X42 backend twin): the join window is the exact negation of the FE's
// isNightNotOver, periodictabletop src/lib/upcomingEvents.ts ("export const DEFAULT_RUN_WINDOW_MINUTES = 480"),
// chosen OVER the old start-instant gate (it killed the QR the owner ruled open while running, P-5)
// and OVER `duration_minutes ?? 480` (a stored 0 would close the window at the start; D47 (c)).
// Status counts only after the start, as the FE's hasStarted is status-blind. Change both or neither.
//
// A night is OVER once it has started AND either its status is no longer live (cancelled or
// completed) or its run window has passed: the stored length when it is a positive finite number,
// else eight hours. An unparseable start is never over (the FE reads it as not started).

const DEFAULT_RUN_WINDOW_MINUTES = 480;

function isNightOver(event, nowMs = Date.now()) {
  const startMs = new Date(event.start_date).getTime();
  if (Number.isNaN(startMs) || startMs > nowMs) return false;
  const status = event.status || 'scheduled';
  if (status !== 'scheduled' && status !== 'in_progress') return true;
  const d = event.duration_minutes;
  const minutes = typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : DEFAULT_RUN_WINDOW_MINUTES;
  return nowMs >= startMs + minutes * 60000;
}

module.exports = { isNightOver, DEFAULT_RUN_WINDOW_MINUTES };
