'use strict';

/**
 * SMS Reply Parser
 *
 * Pure function that classifies inbound SMS text into:
 * - RSVP status (yes/no/maybe)
 * - Opt-out command
 * - Unknown
 *
 * Priority order (first match wins):
 * 1. STOP/opt-out commands (regulatory compliance - always checked first)
 * 2. Exact number match: 1=yes, 2=no, 3=maybe
 * 3. Exact single-word match (case-insensitive)
 * 4. Keyword extraction from surrounding text (word boundary, left-to-right, yes>no>maybe)
 * 5. Unknown
 */

const OPT_OUT_WORDS = ['stop', 'unsubscribe', 'cancel', 'quit', 'end'];

const NUMBER_MAP = {
  '1': 'yes',
  '2': 'no',
  '3': 'maybe'
};

const YES_WORDS = ['yes', 'y', 'yea', 'yep', 'sure', 'yeah', 'absolutely', 'definitely'];
const NO_WORDS = ['no', 'n', 'nah', 'nope', 'cant', "can't", 'cannot'];
const MAYBE_WORDS = ['maybe', 'm', 'possibly', 'perhaps', 'unsure', 'idk'];

const EXACT_WORD_MAP = {};
YES_WORDS.forEach(w => { EXACT_WORD_MAP[w] = 'yes'; });
NO_WORDS.forEach(w => { EXACT_WORD_MAP[w] = 'no'; });
MAYBE_WORDS.forEach(w => { EXACT_WORD_MAP[w] = 'maybe'; });

// Curly/typographic apostrophes -> the ASCII apostrophe the word lists are written with.
// iOS and Android smart punctuation rewrite a typed ' as U+2019 by default, so a real
// phone sends "Can't make it", which matched NOTHING before this normalisation existed
// (CodeQL js/identity-replacement + js/incomplete-sanitization, first scan 2026-09-08:
// the constants were being built with a no-op `w.replace("'", "'")` -- an ASCII
// apostrophe replaced by itself -- which normalised nothing on either side).
//
// DECISION 2026-09-08 (CodeQL hygiene): normalise the INBOUND MESSAGE, chosen OVER
// normalising the static word lists. The lists are ours and already ASCII; the untrusted
// curly character only ever arrives in the SMS body, so that is the only side that can
// carry it. Every replacement here is deliberately ONE character for ONE character:
// step 4 below ranks keywords by `match.index`, so a multi-character substitution would
// silently shift those offsets and change which status wins a tie. Widening this to a
// multi-char rewrite is a decision, not a cleanup.
const TYPOGRAPHIC_APOSTROPHES = /[‘’ʼ]/g;

// Build keyword regex patterns with word boundaries for extraction
// Each entry: [regex, status] -- order matters for same-position tiebreak
const KEYWORD_PATTERNS = [
  ...YES_WORDS.map(w => [new RegExp(`\\b${w}\\b`, 'i'), 'yes']),
  ...NO_WORDS.map(w => [new RegExp(`\\b${w}\\b`, 'i'), 'no']),
  ...MAYBE_WORDS.map(w => [new RegExp(`\\b${w}\\b`, 'i'), 'maybe']),
];

/**
 * Parse an inbound SMS body and classify it.
 *
 * @param {string} body - Raw SMS body text
 * @returns {{ type: 'rsvp', status: 'yes'|'no'|'maybe' } | { type: 'opt_out' } | { type: 'unknown' }}
 */
function parseReply(body) {
  // Edge case: null/undefined/empty
  if (!body || typeof body !== 'string') {
    return { type: 'unknown' };
  }

  const trimmed = body.trim();
  if (!trimmed) {
    return { type: 'unknown' };
  }

  // Fold typographic apostrophes before ANY matching so a phone-typed "Can't" reaches
  // the same branch as "Can't". Applied to `lower` only: `trimmed` is used solely for
  // the digit lookup below, which no apostrophe can affect.
  const lower = trimmed.toLowerCase().replace(TYPOGRAPHIC_APOSTROPHES, "'");

  // 1. Opt-out check (HIGHEST PRIORITY - regulatory compliance)
  for (const word of OPT_OUT_WORDS) {
    const regex = new RegExp(`\\b${word}\\b`, 'i');
    if (regex.test(lower)) {
      return { type: 'opt_out' };
    }
  }

  // 2. Exact number match (trimmed)
  if (NUMBER_MAP[trimmed]) {
    return { type: 'rsvp', status: NUMBER_MAP[trimmed] };
  }

  // 3. Exact single-word match (trimmed, lowered)
  if (EXACT_WORD_MAP[lower]) {
    return { type: 'rsvp', status: EXACT_WORD_MAP[lower] };
  }

  // 4. Keyword extraction -- find earliest match position, left-to-right
  //    For keywords at the same position, priority is yes > no > maybe (due to array order)
  let bestMatch = null;
  let bestIndex = Infinity;

  for (const [regex, status] of KEYWORD_PATTERNS) {
    const match = regex.exec(lower);
    if (match && match.index < bestIndex) {
      bestIndex = match.index;
      bestMatch = status;
    }
  }

  if (bestMatch) {
    return { type: 'rsvp', status: bestMatch };
  }

  // 5. Unknown
  return { type: 'unknown' };
}

module.exports = { parseReply };
