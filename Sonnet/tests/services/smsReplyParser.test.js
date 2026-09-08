const { parseReply } = require('../../services/smsReplyParser');

describe('smsReplyParser', () => {
  describe('parseReply', () => {

    // --- Edge cases: null/undefined/empty ---
    describe('edge cases', () => {
      it('returns unknown for null input', () => {
        expect(parseReply(null)).toEqual({ type: 'unknown' });
      });

      it('returns unknown for undefined input', () => {
        expect(parseReply(undefined)).toEqual({ type: 'unknown' });
      });

      it('returns unknown for empty string', () => {
        expect(parseReply('')).toEqual({ type: 'unknown' });
      });

      it('returns unknown for whitespace-only string', () => {
        expect(parseReply('   ')).toEqual({ type: 'unknown' });
      });

      it('returns unknown for unrecognizable input', () => {
        expect(parseReply('what time does it start?')).toEqual({ type: 'unknown' });
      });
    });

    // --- Opt-out commands (highest priority) ---
    describe('opt-out commands', () => {
      it.each(['STOP', 'stop', 'Stop', 'UNSUBSCRIBE', 'CANCEL', 'QUIT', 'END'])(
        'returns opt_out for "%s"',
        (input) => {
          expect(parseReply(input)).toEqual({ type: 'opt_out' });
        }
      );

      it('returns opt_out for STOP with surrounding whitespace', () => {
        expect(parseReply('  STOP  ')).toEqual({ type: 'opt_out' });
      });

      it('returns opt_out for STOP embedded in a sentence (word boundary)', () => {
        expect(parseReply('Please stop sending me texts')).toEqual({ type: 'opt_out' });
      });

      it('opt_out takes priority over RSVP keywords', () => {
        expect(parseReply('yes but also STOP')).toEqual({ type: 'opt_out' });
      });
    });

    // --- Exact number match ---
    describe('exact number match', () => {
      it('returns yes for "1"', () => {
        expect(parseReply('1')).toEqual({ type: 'rsvp', status: 'yes' });
      });

      it('returns no for "2"', () => {
        expect(parseReply('2')).toEqual({ type: 'rsvp', status: 'no' });
      });

      it('returns maybe for "3"', () => {
        expect(parseReply('3')).toEqual({ type: 'rsvp', status: 'maybe' });
      });

      it('handles whitespace-padded numbers', () => {
        expect(parseReply('  1  ')).toEqual({ type: 'rsvp', status: 'yes' });
      });

      it('returns unknown for other numbers', () => {
        expect(parseReply('4')).toEqual({ type: 'unknown' });
      });
    });

    // --- Exact single-word match: YES variants ---
    describe('exact word - yes variants', () => {
      it.each(['yes', 'y', 'yea', 'yep', 'sure', 'yeah', 'absolutely', 'definitely'])(
        'returns yes for "%s"',
        (input) => {
          expect(parseReply(input)).toEqual({ type: 'rsvp', status: 'yes' });
        }
      );

      it('is case insensitive', () => {
        expect(parseReply('YES')).toEqual({ type: 'rsvp', status: 'yes' });
        expect(parseReply('Yeah')).toEqual({ type: 'rsvp', status: 'yes' });
        expect(parseReply('Y')).toEqual({ type: 'rsvp', status: 'yes' });
      });
    });

    // --- Exact single-word match: NO variants ---
    describe('exact word - no variants', () => {
      it.each(['no', 'n', 'nah', 'nope', 'cant', "can't", 'cannot'])(
        'returns no for "%s"',
        (input) => {
          expect(parseReply(input)).toEqual({ type: 'rsvp', status: 'no' });
        }
      );

      it('is case insensitive', () => {
        expect(parseReply('NO')).toEqual({ type: 'rsvp', status: 'no' });
        expect(parseReply('Nah')).toEqual({ type: 'rsvp', status: 'no' });
        expect(parseReply('N')).toEqual({ type: 'rsvp', status: 'no' });
      });
    });

    // --- Exact single-word match: MAYBE variants ---
    describe('exact word - maybe variants', () => {
      it.each(['maybe', 'm', 'possibly', 'perhaps', 'unsure', 'idk'])(
        'returns maybe for "%s"',
        (input) => {
          expect(parseReply(input)).toEqual({ type: 'rsvp', status: 'maybe' });
        }
      );

      it('is case insensitive', () => {
        expect(parseReply('MAYBE')).toEqual({ type: 'rsvp', status: 'maybe' });
        expect(parseReply('M')).toEqual({ type: 'rsvp', status: 'maybe' });
        expect(parseReply('IDK')).toEqual({ type: 'rsvp', status: 'maybe' });
      });
    });

    // --- Keyword extraction from surrounding text ---
    describe('keyword extraction', () => {
      it('extracts yes from a sentence', () => {
        expect(parseReply("Yes I'll be there!")).toEqual({ type: 'rsvp', status: 'yes' });
      });

      it('extracts no from a sentence', () => {
        expect(parseReply("No I can't make it")).toEqual({ type: 'rsvp', status: 'no' });
      });

      it('extracts maybe from a sentence', () => {
        expect(parseReply("I'm not sure, maybe")).toEqual({ type: 'rsvp', status: 'maybe' });
      });

      it('extracts yeah from informal text', () => {
        expect(parseReply("yeah sounds good!")).toEqual({ type: 'rsvp', status: 'yes' });
      });

      it('extracts nope from informal text', () => {
        expect(parseReply("nope not this time")).toEqual({ type: 'rsvp', status: 'no' });
      });

      it('extracts definitely from a sentence', () => {
        expect(parseReply("I will definitely be there")).toEqual({ type: 'rsvp', status: 'yes' });
      });
    });

    // --- Typographic apostrophes (CodeQL hygiene 2026-09-08) ---
    // iOS/Android smart punctuation rewrites a typed ' as U+2019, so these are the
    // shapes a REAL phone sends. Before the input-side fold they all returned unknown.
    describe('typographic apostrophe normalisation', () => {
      it.each([
        ['U+2019 right single quote', 'can’t'],
        ['U+2018 left single quote', 'can‘t'],
        ['U+02BC modifier letter apostrophe', 'canʼt'],
      ])('treats %s as an ASCII apostrophe in an exact-word reply', (_label, input) => {
        expect(parseReply(input)).toEqual({ type: 'rsvp', status: 'no' });
      });

      it('extracts a curly-apostrophe keyword from surrounding text', () => {
        expect(parseReply('Can’t make it')).toEqual({ type: 'rsvp', status: 'no' });
      });

      it('folds one character to one character, so keyword tiebreak order is unchanged', () => {
        // "yes" sits left of "can't"; a multi-char fold would shift match.index and
        // could flip this to "no". Guards the 1:1 property the fold relies on.
        expect(parseReply('yes I can’t believe it')).toEqual({ type: 'rsvp', status: 'yes' });
      });
    });

    // --- Priority order: keyword scanning (yes > no > maybe) ---
    describe('priority conflicts', () => {
      it('no before maybe - "no" found first wins', () => {
        expect(parseReply("No I can't make it, maybe next time")).toEqual({ type: 'rsvp', status: 'no' });
      });

      it('yes before no - "yes" found first wins', () => {
        expect(parseReply("yes even though I said no before")).toEqual({ type: 'rsvp', status: 'yes' });
      });

      it('opt_out always takes priority over everything', () => {
        expect(parseReply("yes definitely but quit")).toEqual({ type: 'opt_out' });
      });
    });
  });
});
