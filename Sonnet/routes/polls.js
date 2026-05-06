// routes/polls.js
// REST surface for member-created availability polls (POLL-01).
//
// Endpoints (all require Auth0 token; mount in server.js handles that):
//   GET    /api/polls/pending-for-me        — bell-side feed of open polls
//                                              caller hasn't responded to (Plan 71-05)
//   GET    /api/polls/group/:groupId        — active poll for a group + responses
//                                              (D-POLL-CREATE-11 running heatmap visibility)
//   GET    /api/polls/:id                   — single poll fetch
//   POST   /api/polls                       — create poll (D-POLL-CREATE-02 active-only)
//   POST   /api/polls/:id/responses         — upsert caller's response
//   POST   /api/polls/:id/close             — manual close ("End poll", D-POLL-CREATE-13)
//   POST   /api/polls/:id/dismiss-notification — creator dismisses close-notification CTA
//                                                (D-POLL-CREATE-07 cross-device)
//
// Lazy-on-read deadline auto-close runs in:
//   GET /api/polls/group/:groupId
//   GET /api/polls/:id
//   GET /api/polls/pending-for-me (inside getPollsPendingForUser)
// per D-POLL-CREATE-04 REQUIRED deadline path.
const express = require('express');
const router = express.Router();
const pollService = require('../services/pollService');

// ----- IMPORTANT ROUTE-ORDER NOTE -----
// '/pending-for-me' MUST be registered before '/:id' so Express doesn't match
// 'pending-for-me' as the :id parameter. Same goes for '/group/:groupId'.

// GET /api/polls/pending-for-me — open polls in any group where caller is active
// member AND has not yet responded (consumed by Plan 71-05 NotificationBell).
// Runs lazy-on-read deadline auto-close inside getPollsPendingForUser.
router.get('/pending-for-me', async (req, res) => {
  try {
    const polls = await pollService.getPollsPendingForUser(req.user.user_id);
    res.json(polls);
  } catch (err) {
    console.error('[polls] GET /pending-for-me error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/polls/group/:groupId — active poll + responses (D-POLL-CREATE-11).
// Lazy-on-read deadline auto-close: if response_deadline is past, force-close
// before returning so any read by any user surfaces the closed state.
router.get('/group/:groupId', async (req, res) => {
  try {
    let poll = await pollService.getActivePoll(req.params.groupId);
    if (!poll) return res.json(null);
    if (poll.status === 'open' && new Date(poll.response_deadline) <= new Date()) {
      await pollService.checkAutoClose(poll.id);
      // Refetch — getActivePoll only returns 'open', so a deadline close means
      // we return null here (active poll surface clears).
      poll = await pollService.getActivePoll(req.params.groupId);
      if (!poll) return res.json(null);
    }
    res.json(poll);
  } catch (err) {
    console.error('[polls] GET /group/:groupId error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/polls/:id — single poll fetch with lazy-on-read deadline auto-close.
router.get('/:id', async (req, res) => {
  try {
    let poll = await pollService.getPoll(req.params.id);
    if (!poll) return res.status(404).json({ error: 'Poll not found' });
    if (poll.status === 'open' && new Date(poll.response_deadline) <= new Date()) {
      await pollService.checkAutoClose(poll.id);
      poll = await pollService.getPoll(req.params.id);
    }
    res.json(poll);
  } catch (err) {
    console.error('[polls] GET /:id error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/polls — create (D-POLL-CREATE-02 active members only enforced in service)
router.post('/', async (req, res) => {
  try {
    const { group_id, date_window_start, date_window_end, response_deadline } = req.body;
    if (!group_id || !date_window_start || !date_window_end || !response_deadline) {
      return res.status(400).json({
        error: 'group_id, date_window_start, date_window_end, response_deadline are required',
      });
    }
    const poll = await pollService.createPoll({
      groupId: group_id,
      userId: req.user.user_id,
      dateWindowStart: date_window_start,
      dateWindowEnd: date_window_end,
      responseDeadline: response_deadline,
    });
    res.status(201).json(poll);
  } catch (err) {
    console.error('[polls] POST / error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/polls/:id/responses — upsert caller's response
router.post('/:id/responses', async (req, res) => {
  try {
    const { slot_data } = req.body;
    if (!Array.isArray(slot_data)) {
      return res.status(400).json({ error: 'slot_data must be an array' });
    }
    const response = await pollService.submitResponse({
      pollId: req.params.id,
      userId: req.user.user_id,
      slotData: slot_data,
    });
    res.json(response);
  } catch (err) {
    console.error('[polls] POST /:id/responses error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/polls/:id/close — manual close ("End poll", D-POLL-CREATE-13).
// Authorization (creator/admin/owner) enforced inside pollService.closePoll().
router.post('/:id/close', async (req, res) => {
  try {
    const poll = await pollService.closePoll({
      pollId: req.params.id,
      reason: 'manual',
      byUserId: req.user.user_id,
    });
    res.json(poll);
  } catch (err) {
    console.error('[polls] POST /:id/close error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/polls/:id/dismiss-notification — creator dismisses close-notification CTA
// (D-POLL-CREATE-07 cross-device guarantee — server-side state, not localStorage).
router.post('/:id/dismiss-notification', async (req, res) => {
  try {
    const poll = await pollService.dismissCloseNotification({
      pollId: req.params.id,
      userId: req.user.user_id,
    });
    res.json(poll);
  } catch (err) {
    console.error('[polls] POST /:id/dismiss-notification error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
