// routes/events.js
const express = require('express');
const crypto = require('crypto');
const { Event, Game, User, Group, EventParticipation, UserGroup, EventRsvp, EventBring, EventBallotOption, EventBallotVote, EventAuditLog } = require('../models');
const { Op } = require('sequelize');
const sequelize = require('../config/database');
const router = express.Router();
const auth0Service = require('../services/auth0Service');
const googleCalendarService = require('../services/googleCalendarService');
const emailService = require('../services/emailService');
const icsService = require('../services/icsService');
const notificationService = require('../services/notificationService');
const { generateRsvpUrl, mintRsvpBatch } = require('./rsvp');

// MAIL-05 lifecycle constant: cancellation emails fire within 15 minutes
// after start_time (covers the "oops, no one showed" case). After that
// window, deletes are silent (audit log still written).
const FIFTEEN_MIN_MS = 15 * 60 * 1000;

// Helper function to format event with custom participants
const formatEventWithCustomParticipants = (event) => {
  const eventData = event.toJSON ? event.toJSON() : event;
  
  // Combine regular participants (from EventParticipation) with custom participants
  const regularParticipants = (eventData.EventParticipations || []).map(ep => ({
    user_id: ep.User?.id,
    username: ep.User?.username,
    // BSEC-01 (D-03): email removed from the participant roster serializer —
    // it was leaking PII into every event response and serves no display use.
    score: ep.score,
    faction: ep.faction,
    is_new_player: ep.is_new_player,
    placement: ep.placement,
    is_guest: ep.is_guest || false,
    is_custom: false
  }));
  
  const customParticipants = (eventData.custom_participants || []).map(cp => ({
    user_id: null,
    username: cp.username,
    score: cp.score,
    faction: cp.faction,
    is_new_player: cp.is_new_player || false,
    placement: cp.placement,
    is_custom: true
  }));
  
  // Combine and sort by placement if available
  const allParticipants = [...regularParticipants, ...customParticipants];
  if (allParticipants.some(p => p.placement !== null)) {
    allParticipants.sort((a, b) => {
      if (a.placement === null) return 1;
      if (b.placement === null) return -1;
      return a.placement - b.placement;
    });
  }
  
  // Format winner and picked_by to include custom names
  let winner = null;
  if (eventData.Winner) {
    winner = {
      id: eventData.Winner.id,
      username: eventData.Winner.username
    };
  } else if (eventData.winner_name) {
    winner = {
      id: null,
      username: eventData.winner_name,
      is_custom: true
    };
  }
  
  let pickedBy = null;
  if (eventData.PickedBy) {
    pickedBy = {
      id: eventData.PickedBy.id,
      username: eventData.PickedBy.username
    };
  } else if (eventData.picked_by_name) {
    pickedBy = {
      id: null,
      username: eventData.picked_by_name,
      is_custom: true
    };
  }
  
  return {
    ...eventData,
    EventParticipations: allParticipants, // Replace with combined participants
    Winner: winner,
    PickedBy: pickedBy
  };
};
const { validateEventCreate, validateEventUpdate, validateUUID } = require('../middleware/validators');
const { requireParamMatchesToken } = require('../middleware/objectAuth');
const {
  isOwnerOrAdmin,
  isActiveMember,
  isMemberOrHigher,
  canReadEventScopedSurface,
} = require('../services/authorizationService');

// Phase 71.1-02 — Cascade a user's per-event side rows when they are removed
// from an event (called from DELETE /:event_id/participations/:user_id and
// from PUT /:id Edit Event for each diff'd-removed participant).
//
// :userUuid is the User.id UUID (matches EventParticipation.user_id). The
// RSVP / EventBring / EventBallotVote tables are Auth0-string-keyed, so we
// resolve the target's Auth0 string user_id via User.findByPk first. The
// user_id type asymmetry is load-bearing — see services/authorizationService.js
// and the Phase 71.1-01 SUMMARY.
//
// Caller is responsible for destroying the EventParticipation row itself and
// for opening the surrounding transaction. This helper does NOT write the
// EventAuditLog 'remove_participant' row — that stays at the call site so
// each endpoint can emit its own context (actor, suppressed_email, etc.) per
// the EVT-08 silent-welcome-back contract from Phase 65-01.
const cascadeRemoveUserFromEvent = async ({ event_id, userUuid, transaction }) => {
  const targetUser = await User.findByPk(userUuid, {
    attributes: ['user_id'],
    transaction,
  });
  if (!targetUser) return;
  const targetAuth0Id = targetUser.user_id;

  await EventRsvp.destroy({
    where: { event_id, user_id: targetAuth0Id },
    transaction,
  });
  await EventBring.destroy({
    where: { event_id, user_id: targetAuth0Id },
    transaction,
  });
  const ballotOptions = await EventBallotOption.findAll({
    where: { event_id },
    attributes: ['id'],
    transaction,
  });
  if (ballotOptions.length > 0) {
    await EventBallotVote.destroy({
      where: {
        option_id: { [Op.in]: ballotOptions.map(o => o.id) },
        user_id: targetAuth0Id,
      },
      transaction,
    });
  }
};

// Helper: attach RSVP summary counts to an array of formatted events
const attachRsvpSummaries = async (events) => {
  const eventIds = events.map(e => e.id);
  if (eventIds.length === 0) return events;

  const rsvps = await EventRsvp.findAll({
    where: { event_id: { [Op.in]: eventIds } },
    attributes: ['event_id', 'status'],
    raw: true,
  });

  // Build counts map: { event_id: { yes: N, maybe: N, no: N } }
  const countsMap = {};
  for (const r of rsvps) {
    if (!countsMap[r.event_id]) countsMap[r.event_id] = { yes: 0, maybe: 0, no: 0 };
    if (countsMap[r.event_id][r.status] !== undefined) {
      countsMap[r.event_id][r.status]++;
    }
  }

  return events.map(e => ({
    ...e,
    rsvp_summary: countsMap[e.id] || { yes: 0, maybe: 0, no: 0 },
  }));
};


// Get all events for a user across all their groups
// BSEC-01 (Task 1 audit, Rule 2 — same shape as BE-048): this READ was NOT
// self-gated — only the auto-create branch checked the actor against the param,
// so any authenticated user could read ANY user's full cross-group event list
// (including participant emails). Add the object-level self-gate. The frontend
// only calls this for the logged-in user (eventsAPI.getUserEvents on UserHome).
router.get('/user/:user_id', requireParamMatchesToken('user_id'), async (req, res) => {
  try {
    let user = await User.findOne({ where: { user_id: req.params.user_id } });
    
    // If user doesn't exist but we have authenticated user info, auto-create
    if (!user && req.user && req.user.user_id === req.params.user_id) {
      let userEmail = req.user.email;
      let userName = req.user.name || req.user.nickname || req.user.given_name || req.user.email?.split('@')[0] || 'User';
      
      // If email is missing from token, try to fetch from Auth0 Management API
      if (!userEmail || userEmail.includes('@auth0.local') || userEmail.includes('@auth0')) {
        try {
          const auth0User = await auth0Service.getUserById(req.params.user_id);
          if (auth0User) {
            const userDetails = auth0Service.extractUserDetails(auth0User);
            userEmail = userDetails.email;
            userName = userDetails.username;
          }
        } catch (auth0Error) {
          // If Management API fails, continue with fallback
          console.warn('Auth0 Management API lookup failed during user creation:', auth0Error.message);
        }
      }
      
      // Improve username extraction for email/password users
      if (!userEmail || userEmail.includes('@auth0.local') || userEmail.includes('@auth0')) {
        userEmail = `${req.params.user_id.replace(/[|:]/g, '-')}@auth0.local`;
      }
      
      // If username is still generic, try to extract from email
      if (userName === 'User' && userEmail && !userEmail.includes('@auth0.local') && !userEmail.includes('@auth0')) {
        userName = userEmail.split('@')[0];
      }
      
      // Combine given_name and family_name if available
      if (req.user.given_name || req.user.family_name) {
        const fullName = [req.user.given_name, req.user.family_name].filter(Boolean).join(' ').trim();
        if (fullName) {
          userName = fullName;
        }
      }
      
      try {
        const [newUser, created] = await User.findOrCreate({
          where: { user_id: req.params.user_id },
          defaults: {
            user_id: req.params.user_id,
            email: userEmail,
            username: userName,
          }
        });
        
        // If user already existed but has wrong email/username, update them
        if (!created) {
          const needsUpdate = 
            (newUser.email !== userEmail && !newUser.email.includes('@auth0.local') && !newUser.email.includes('@auth0')) ||
            (newUser.username === 'User' && userName !== 'User');
          
          if (needsUpdate) {
            await newUser.update({
              email: userEmail,
              username: userName
            });
          }
        }
        
        user = newUser;
      } catch (error) {
        console.error('Error auto-creating user:', error.message);
        user = await User.findOne({ where: { user_id: req.params.user_id } });
        if (!user) {
          throw error;
        }
      }
    }
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Get all groups the user belongs to
    const userGroups = await UserGroup.findAll({
      where: { user_id: user.user_id, status: 'active' }, // Use user.user_id (Auth0 string) not user.id (UUID)
      attributes: ['group_id']
    });

    const groupIds = userGroups.map(ug => ug.group_id);

    // Phase 71.1: UNION game-only events (EventParticipation rows where the
    // user has no UserGroup row in the event's group). Without this, a user
    // who joined a single event via the QR-game-invite never sees it on
    // UserHomePage. EventParticipation.user_id is a User.id UUID — use the
    // resolved `user.id` from above.
    const participations = await EventParticipation.findAll({
      where: { user_id: user.id },
      attributes: ['event_id']
    });
    const participatingEventIds = participations.map(p => p.event_id);

    if (groupIds.length === 0 && participatingEventIds.length === 0) {
      return res.json([]);
    }

    // UNION via Op.or — events from the user's groups OR events the user is
    // participating in directly (game-only QR-join). Postgres dedupes
    // naturally because Event.id is unique; group-member callers attending a
    // game-invite event in a group they ALSO belong to still get a single
    // row in the response.
    const orClauses = [];
    if (groupIds.length > 0) orClauses.push({ group_id: { [Op.in]: groupIds } });
    if (participatingEventIds.length > 0) orClauses.push({ id: { [Op.in]: participatingEventIds } });

    const events = await Event.findAll({
      where: { [Op.or]: orClauses },
      include: [
        { model: Game, attributes: ['id', 'name', 'image_url', 'theme'] },
        {
          model: Group,
          attributes: ['id', 'name', 'profile_picture_url', 'background_color', 'background_image_url']
        },
        { model: User, as: 'Winner', attributes: ['id', 'username', 'user_id'] },
        { model: User, as: 'PickedBy', attributes: ['id', 'username'] },
        {
          model: EventParticipation,
          include: [{ model: User, attributes: ['id', 'username', 'user_id'] }]
        }
      ],
      order: [['start_date', 'DESC']]
    });

    // Format all events with custom participants
    let formattedEvents = events.map(event => formatEventWithCustomParticipants(event));

    // Optionally include RSVP summary counts
    if (req.query.include_rsvp_summary) {
      formattedEvents = await attachRsvpSummaries(formattedEvents);
    }

    res.json(formattedEvents);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all events for a group
router.get('/group/:group_id', async (req, res) => {
  try {
    // BSEC-01 / BE-040: this was bypassable — membership was only checked IF a
    // `req.query.user_id` was present, so omitting the param skipped the gate
    // entirely (and trusted a client-supplied actor besides). Fix: derive the
    // actor from the verified JWT (Auth0 STRING) and ALWAYS membership-check.
    const callerAuth0Id = req.user?.user_id;
    if (!callerAuth0Id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const hasAccess = await isActiveMember(callerAuth0Id, req.params.group_id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied to this group' });
    }

    const events = await Event.findAll({
      where: { group_id: req.params.group_id },
      include: [
        { model: Game, attributes: ['name', 'image_url', 'theme'] },
        {
          model: Group,
          attributes: ['id', 'name', 'profile_picture_url', 'background_color', 'background_image_url']
        },
        { model: User, as: 'Winner', attributes: ['id', 'username', 'user_id'] },
        { model: User, as: 'PickedBy', attributes: ['id', 'username'] },
        {
          model: EventParticipation,
          // BSEC-01 / BE-040: drop `email` from the participation roster (PII leak).
          include: [{ model: User, attributes: ['id', 'username', 'user_id'] }]
        }
      ],
      order: [['start_date', 'DESC']]
    });

    // Format all events with custom participants
    let formattedEvents = events.map(event => formatEventWithCustomParticipants(event));

    // Optionally include RSVP summary counts
    if (req.query.include_rsvp_summary) {
      formattedEvents = await attachRsvpSummaries(formattedEvents);
    }

    res.json(formattedEvents);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Get a single event by ID (must come after /user/ and /group/ routes)
router.get('/:event_id', async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Phase 71.1: this endpoint previously had NO authz gate (any
    // authenticated user could fetch any event detail — T-71.1-01
    // information disclosure). Add canReadEventScopedSurface so:
    //   - active group members pass for any event in their group
    //   - game-only participants pass ONLY for events they joined
    //   - everyone else gets 403 (or 404 if the event doesn't exist)
    const { allowed, event: gateEvent } = await canReadEventScopedSurface(userId, req.params.event_id);
    if (!gateEvent) {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (!allowed) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Re-fetch with includes — gateEvent is the bare row.
    // Phase 71.1-02 Blocker 2 fix: include Group so the frontend breadcrumb
    // can render "Game night with [actual group name]" instead of falling back
    // to the literal word "group". The plan's GAMP-11 acceptance copy depends
    // on Group.name being present in the response. Without this include, the
    // frontend's `singleEvent?.Group?.name || 'group'` fallback always fired
    // because Group was never eager-loaded on this endpoint after the Plan 01
    // gate swap.
    const event = await Event.findByPk(req.params.event_id, {
      include: [
        { model: Game, attributes: ['name', 'image_url', 'theme'] },
        { model: Group, attributes: ['id', 'name'] },
        { model: User, as: 'Winner', attributes: ['id', 'username', 'user_id'] },
        { model: User, as: 'PickedBy', attributes: ['id', 'username'] },
        {
          model: EventParticipation,
          include: [{ model: User, attributes: ['id', 'username', 'user_id'] }]
        }
      ]
    });

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    res.json(formatEventWithCustomParticipants(event));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create new event
router.post('/', validateEventCreate, async (req, res) => {
  try {
    // Verify user is at least a full member (pending members cannot create events)
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const {
      group_id,
      game_id,
      start_date,
      duration_minutes,
      winner_id,
      picked_by_id,
      winner_name,
      picked_by_name,
      is_group_win,
      comments,
      participants, // Array of { user_id, score, faction, is_new_player, placement }
      custom_participants, // Array of { username, score, faction, is_new_player, placement }
      timezone, // User's timezone (e.g., 'America/Los_Angeles')
      rsvp_deadline, // ISO date string for RSVP/ballot close
      ballot_options // Optional array of { game_id, game_name } for atomic ballot creation
    } = req.body;

    const hasPermission = await isMemberOrHigher(userId, group_id);
    if (!hasPermission) {
      return res.status(403).json({ error: 'Pending members cannot perform this action', required_role: 'member' });
    }

    // Phase 87 (adversarial review #6/#7): a caller-supplied ballot (>=2 options
    // + a deadline) must resolve to >=2 DISTINCT non-empty trimmed game_names.
    // The in-transaction de-dup below drops duplicates; if that would collapse
    // the ballot below 2 we must reject LOUDLY here, BEFORE creating anything —
    // otherwise the event is created with no ballot and the route still returns
    // 201, which the FE treats as full success, so the intended ballot vanishes
    // with no signal. This validates before the write set so no ballot-less
    // event is ever persisted for this input.
    if (Array.isArray(ballot_options) && ballot_options.length >= 2 && rsvp_deadline) {
      const distinctBallotNames = new Set(
        ballot_options
          .filter(o => o.game_name && o.game_name.trim())
          .map(o => o.game_name.trim())
      );
      if (distinctBallotNames.size < 2) {
        return res.status(400).json({ error: 'Ballot options must have at least 2 distinct game names' });
      }
    }

    // Phase 87 (BINT-01, T-87-08-01): wrap the multi-write set — Event.create,
    // EventParticipation.bulkCreate, and the ballot-materialization block — in
    // ONE managed transaction (the in-file form already used at the participant-
    // swap and self-removal paths). A mid-write failure (e.g. a duplicate ballot
    // game_name hitting the (event_id, game_name) unique index, or a participant
    // user_id that violates the Plan-07 FK) now rolls the whole write back → no
    // orphaned Event row. The read-only re-fetch + response stay OUTSIDE (post-commit).
    let event;
    let hasBallot = false;
    await sequelize.transaction(async (t) => {
      event = await Event.create({
        group_id,
        game_id,
        start_date,
        duration_minutes,
        winner_id,
        picked_by_id,
        winner_name: winner_name || null,
        picked_by_name: picked_by_name || null,
        custom_participants: custom_participants || [],
        is_group_win,
        comments,
        status: 'completed',
        rsvp_deadline: rsvp_deadline || null,
        ballot_status: null
      }, { transaction: t });

      // Create participations for group members (with user_id)
      if (participants && participants.length > 0) {
        const participationData = participants
          .filter(p => p.user_id) // Only include participants with user_id
          .map(p => ({
            event_id: event.id,
            user_id: p.user_id,
            score: p.score,
            faction: p.faction,
            is_new_player: p.is_new_player || false,
            placement: p.placement
          }));

        if (participationData.length > 0) {
          await EventParticipation.bulkCreate(participationData, { transaction: t });
        }
      }

      // Create ballot options atomically with the event (if provided)
      // This ensures ballot exists BEFORE notifications fire
      if (ballot_options && Array.isArray(ballot_options) && ballot_options.length >= 2 && rsvp_deadline) {
        const validOptions = ballot_options.filter(o => o.game_name && o.game_name.trim());

        // Phase 87 (T-87-08-01): DE-DUPLICATE by trimmed game_name (keep first
        // occurrence) BEFORE building optionRows so the (event_id, game_name)
        // unique index cannot be weaponized into a mid-transaction 500. Preserve
        // display_order sequencing over the de-duped list.
        const seenNames = new Set();
        const dedupedOptions = [];
        for (const opt of validOptions) {
          const key = opt.game_name.trim();
          if (seenNames.has(key)) continue;
          seenNames.add(key);
          dedupedOptions.push(opt);
        }

        if (dedupedOptions.length >= 2) {
          const optionRows = dedupedOptions.map((opt, index) => ({
            event_id: event.id,
            game_id: opt.game_id || null,
            game_name: opt.game_name.trim(),
            display_order: index,
            // Phase 87 (BINT-01, T-87-04): stamp the ballot creator from the
            // verified Auth0 sub (Phase 83 default-deny) — NEVER a client-supplied
            // id. This is the REAL production ballot-creation path (the FE births
            // every ballot via POST /events with embedded ballot_options), so
            // without this every ballot is created_by=NULL and the "creator can
            // replace/wipe" branch of Req 7 is dead in production.
            created_by: req.user.user_id,
          }));
          await EventBallotOption.bulkCreate(optionRows, { transaction: t });
          event.ballot_status = 'open';
          await event.save({ transaction: t });
          hasBallot = true;
        }
      }
    });

    // Fetch complete event data
    const completeEvent = await Event.findByPk(event.id, {
      include: [
        { model: Game, attributes: ['name', 'image_url'] },
        { model: User, as: 'Winner', attributes: ['id', 'username', 'user_id'] },
        { model: User, as: 'PickedBy', attributes: ['id', 'username'] },
        {
          model: EventParticipation,
          include: [{ model: User, attributes: ['id', 'username', 'user_id'] }]
        }
      ]
    });

    // Format event with custom participants
    const formattedEvent = formatEventWithCustomParticipants(completeEvent);

    // Check if event is in the future (for Google Calendar and email notifications)
    const isFutureEvent = googleCalendarService.isFutureEvent(start_date);
    
    if (isFutureEvent) {
      // Get group details for notifications
      const group = await Group.findByPk(group_id, {
        include: [{
          model: User,
          attributes: ['id', 'user_id', 'username', 'email', 'email_notifications_enabled', 'google_calendar_token', 'google_calendar_refresh_token', 'google_calendar_enabled', 'sms_enabled', 'phone', 'phone_verified', 'notification_preferences', 'timezone'],
          through: { where: { status: 'active' }, attributes: ['role'] }
        }]
      });
      
      if (group && group.Users) {
        const game = await Game.findByPk(game_id, { attributes: ['name'] });
        
        // Add to Google Calendar if event is in the future
        // NOTE: This requires users to have Google Calendar tokens stored
        // See GOOGLE_CALENDAR_SETUP.md for setup instructions
        try {
          const eventDataForCalendar = {
            start_date: start_date,
            duration_minutes: duration_minutes || 60,
            game_name: game?.name || 'Game Night',
            comments: comments || '',
            timezone: timezone || 'UTC' // Use user's timezone, fallback to UTC
          };
          
          // Create calendar events for event participants with Google Calendar connected
          // Get participant user IDs from EventParticipations (exclude custom participants)
          const participantUserIds = completeEvent.EventParticipations
            .filter(ep => ep.User && ep.User.id)
            .map(ep => ep.User.id);
          
          // Get participant user details (only those who are in the event)
          const participantMembers = group.Users.filter(user => 
            participantUserIds.includes(user.id)
          );
          
          // Create calendar events for participants with Google Calendar connected
          // This will silently fail if no users have tokens, which is expected
          const calendarResults = await googleCalendarService.createCalendarEventsForGroup(
            eventDataForCalendar,
            participantMembers
          );

          // Phase 75 / GCAL-01 (Plan 75-01): persist the GCal event id on
          // every connected attendee's EventParticipation row so the cleanup
          // worker (Plan 75-03) can find what to remove on cancel/delete/
          // RSVP-no. The same GCal event id is shared across host + invitee
          // calendars (Google's invitation propagation), so each user's own
          // token + this id identifies the event on their primary calendar.
          if (calendarResults.length > 0 && calendarResults[0].gcal_event_id) {
            const gcalEventId = calendarResults[0].gcal_event_id;
            const connectedUserUuids = calendarResults[0].connected_member_ids || [];
            if (connectedUserUuids.length > 0) {
              await EventParticipation.update(
                { google_calendar_event_id: gcalEventId },
                { where: { event_id: completeEvent.id, user_id: connectedUserUuids } }
              );
            }
          }
        } catch (calendarError) {
          // Log error but don't fail the event creation
          if (process.env.NODE_ENV === 'development') {
            console.error('Error adding event to Google Calendar (non-fatal):', calendarError.message);
          } else {
            console.error('Error adding event to Google Calendar (non-fatal)');
          }
        }
        
        // Send notifications (email + SMS) through unified dispatch
        try {
          // Get participant user IDs from EventParticipations
          const participantUserIds = completeEvent.EventParticipations
            .filter(ep => ep.User && ep.User.id)
            .map(ep => ep.User.id);

          // Population 1: Email recipients -- MUST match current behavior exactly
          // Only users who are event participants AND have valid email
          const emailRecipients = group.Users.filter(user => {
            const isParticipant = participantUserIds.includes(user.id);
            const hasValidEmail = user.email && !user.email.includes('@auth0.local') && !user.email.includes('@auth0');
            return isParticipant && hasValidEmail && user.email_notifications_enabled !== false;
          });

          // Population 2: SMS recipients -- all group members with SMS enabled (for creation)
          const smsRecipients = group.Users.filter(user => {
            return user.sms_enabled && user.phone;
          });

          // Merge into unified recipient list (deduplicated by user_id)
          const recipientMap = new Map();
          emailRecipients.forEach(u => recipientMap.set(u.user_id, { ...u.dataValues, _emailEligible: true }));
          smsRecipients.forEach(u => {
            if (recipientMap.has(u.user_id)) {
              recipientMap.get(u.user_id)._smsEligible = true;
            } else {
              recipientMap.set(u.user_id, { ...u.dataValues, _smsEligible: true });
            }
          });
          const recipients = Array.from(recipientMap.values());

          if (recipients.length > 0) {
            const frontendUrl = process.env.FRONTEND_URL || process.env.AUTH0_BASE_URL || 'http://localhost:3000';
            const eventUrl = `${frontendUrl}/gameDetail?event_id=${event.id}&group_id=${group_id}`;
            const ballotUrl = hasBallot ? `${eventUrl}#vote` : null;

            // D-04 / BSEC-03: mint the three single-use RSVP rows (yes/maybe/no)
            // per email-eligible recipient BEFORE the (synchronous) mapper builds
            // the HMAC links. The row nonce IS the HMAC token, so the links the
            // mapper generates are exactly the consumable rows. Best-effort:
            // a mint failure must never block event creation.
            await Promise.all(
              recipients
                .filter((u) => u._emailEligible && u.email)
                .map((u) =>
                  mintRsvpBatch(event.id, u.user_id).catch((err) =>
                    console.error('Error minting RSVP single-use batch (non-fatal):', err.message)
                  )
                )
            );

            const notifyPromises = notificationService.sendToMany(recipients, 'event_created', (user) => {
              const recipientTz = user.timezone || 'UTC';
              const eventDate = new Date(start_date);

              // Format dateTime for SMS templates (recipient's timezone, 12h with TZ).
              // Email template formats its own time internally via formatEventTime12h (MAIL-04).
              const formattedDateTime = eventDate.toLocaleDateString('en-US', {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                hour12: true,
                timeZone: recipientTz,
                timeZoneName: 'short',
              });

              const rsvpUrls = {
                yesUrl: generateRsvpUrl(frontendUrl, event.id, user.user_id, 'yes'),
                maybeUrl: generateRsvpUrl(frontendUrl, event.id, user.user_id, 'maybe'),
                noUrl: generateRsvpUrl(frontendUrl, event.id, user.user_id, 'no'),
              };

              // emailParams: ONLY set when this user is email-eligible (participant with valid email)
              // Setting emailParams to null prevents notificationService from attempting email send
              let emailParams = null;
              if (user._emailEligible && user.email) {
                const { html, text } = emailService.generateGameSessionEmailTemplate({
                  gameName: game?.name || 'Game Night',
                  groupName: group.name,
                  startDate: start_date,
                  durationMinutes: duration_minutes || 60,
                  location: null,
                  comments: comments || null,
                  eventUrl,
                  recipientName: user.username,
                  rsvpUrls,
                  ballotUrl,
                  timezone: recipientTz,
                });

                emailParams = {
                  to: user.email,
                  subject: `New Game Session: ${game?.name || 'Game Night'} - ${group.name}`,
                  html,
                  text,
                  groupName: group.name
                };
              }

              return {
                emailParams,
                // eventId required for SentNotification logging (notificationService.js:97)
                // — without it, inbound SMS replies (RSVP via "1"/"2"/"3") cannot resolve
                // back to this event in the webhook handler.
                eventId: event.id,
                data: {
                  eventName: game?.name || 'Game Night',
                  groupName: group.name,
                  dateTime: formattedDateTime,
                  eventUrl,
                  rsvpPrompt: true,
                  ballotUrl,
                }
              };
            });

            // Fire-and-forget (matches existing pattern)
            Promise.allSettled([notifyPromises]).catch(err => {
              console.error('Error sending event notifications (non-fatal):', err.message);
            });
          }
        } catch (notifyError) {
          // Log error but don't fail the event creation
          console.error('Error preparing event notifications (non-fatal):', notifyError.message);
          if (process.env.NODE_ENV === 'development') {
            console.error('Notification error details:', notifyError);
          }
        }
      }
    }
    
    res.json(formattedEvent);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Update event
router.put('/:id', validateUUID('id'), validateEventUpdate, async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const event = await Event.findByPk(req.params.id);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    // Check if user is owner or admin of the group
    const hasPermission = await isOwnerOrAdmin(userId, event.group_id);
    if (!hasPermission) {
      return res.status(403).json({ error: 'Only group owners and admins can edit events' });
    }
    
    const {
      game_id,
      start_date,
      duration_minutes,
      winner_id,
      picked_by_id,
      winner_name,
      picked_by_name,
      is_group_win,
      comments,
      participants,
      custom_participants,
      rsvp_deadline
    } = req.body;

    // Capture old start_date before update to detect date changes
    const oldStartDate = event.start_date;

    await event.update({
      game_id: game_id !== undefined ? (game_id || null) : event.game_id,
      start_date,
      duration_minutes,
      winner_id: winner_id || null,
      picked_by_id: picked_by_id || null,
      winner_name: winner_name || null,
      picked_by_name: picked_by_name || null,
      custom_participants: custom_participants || [],
      is_group_win,
      comments,
      rsvp_deadline: rsvp_deadline || null
    });

    // Update participations if provided.
    //
    // Phase 71.1-02: this PUT path was the "Edit Event → remove participant"
    // surface user-tested. The destroy-then-recreate pattern dropped the
    // EventParticipation row but never cascaded the removed user's RSVP /
    // EventBring / EventBallotVote rows, so they orphaned and stayed visible
    // to organizers (same bug class as the leave-group / leave-event cascade
    // gaps, third trigger).
    //
    // Fix: capture the OLD participant UUIDs before destroy, compute removed =
    // old - new from req.body.participants, then cascade RSVP/brings/votes
    // for each removed user via the shared helper. Wrap destroy + recreate +
    // cascade in one transaction so the participant set transition is atomic.
    if (participants) {
      const oldParticipations = await EventParticipation.findAll({
        where: { event_id: event.id },
        attributes: ['user_id'],
      });
      const oldUserIds = new Set(oldParticipations.map(p => p.user_id));
      const newUserIds = new Set(
        participants.filter(p => p.user_id).map(p => p.user_id)
      );
      const removedUserIds = [...oldUserIds].filter(id => !newUserIds.has(id));

      await sequelize.transaction(async (t) => {
        await EventParticipation.destroy({ where: { event_id: event.id }, transaction: t });

        if (participants.length > 0) {
          const participationData = participants
            .filter(p => p.user_id)
            .map(p => ({
              event_id: event.id,
              user_id: p.user_id,
              score: p.score,
              faction: p.faction,
              is_new_player: p.is_new_player || false,
              placement: p.placement,
            }));
          if (participationData.length > 0) {
            await EventParticipation.bulkCreate(participationData, { transaction: t });
          }
        }

        for (const removedUuid of removedUserIds) {
          await cascadeRemoveUserFromEvent({
            event_id: event.id,
            userUuid: removedUuid,
            transaction: t,
          });
        }
      });

      // Audit-log writes — non-fatal, outside the transaction (mirrors the
      // DELETE endpoint pattern). One row per removed user so EVT-08
      // silent-welcome-back suppression on QR re-join works the same whether
      // the user was removed via Edit Event or via the per-row Remove control.
      for (const removedUuid of removedUserIds) {
        try {
          const removeNowMs = Date.now();
          const startMs = event.start_date ? new Date(event.start_date).getTime() : 0;
          const wasAfterStart = startMs > 0 && removeNowMs >= startMs;
          const wasWithin15MinGrace = wasAfterStart && removeNowMs < startMs + FIFTEEN_MIN_MS;
          await EventAuditLog.create({
            event_id: event.id,
            group_id: event.group_id,
            actor_user_id: userId,
            action: 'remove_participant',
            was_after_start: wasAfterStart,
            was_within_15min_grace: wasWithin15MinGrace,
            suppressed_email: false,
            event_snapshot: {
              id: event.id,
              group_id: event.group_id,
              game_id: event.game_id,
              start_date: event.start_date,
              duration_minutes: event.duration_minutes,
              location: event.location || null,
              comments: event.comments || null,
              removed_user_id: removedUuid,
            },
          });
        } catch (auditErr) {
          console.error('[events:put-participants] audit log write failed (non-fatal):', auditErr.message);
        }
      }
    }

    // Fetch updated event
    const updatedEvent = await Event.findByPk(event.id, {
      include: [
        { model: Game, attributes: ['name', 'image_url'] },
        { model: User, as: 'Winner', attributes: ['id', 'username', 'user_id'] },
        { model: User, as: 'PickedBy', attributes: ['id', 'username'] },
        {
          model: EventParticipation,
          include: [{ model: User, attributes: ['id', 'username', 'user_id'] }]
        }
      ]
    });

    // Format event with custom participants
    const formattedEvent = formatEventWithCustomParticipants(updatedEvent);

    // MAIL-05 update lifecycle gate: stop firing update emails AT old start_time
    // (no grace window). Use the OLD start time as the cutoff — once an event has
    // started, recipients are en route or on-site; emailing them about a venue
    // change post-start is worse than silent.
    const dateChanged = start_date && String(oldStartDate) !== String(start_date);
    const updateNowMs = Date.now();
    const oldStartMs = oldStartDate ? new Date(oldStartDate).getTime() : 0;
    const updateEmailsAllowed = oldStartMs > 0 && updateNowMs < oldStartMs;

    if (dateChanged && updateEmailsAllowed) {
      try {
        // Find members who RSVPed yes or maybe
        const rsvpMembers = await EventRsvp.findAll({
          where: {
            event_id: event.id,
            status: { [Op.in]: ['yes', 'maybe'] },
          },
          include: [{
            model: User,
            attributes: ['id', 'user_id', 'username', 'email', 'email_notifications_enabled', 'sms_enabled', 'phone', 'phone_verified', 'notification_preferences', 'timezone'],
          }],
        });

        const rsvpUsers = rsvpMembers.filter(r => r.User).map(r => r.User);

        // Email recipients: RSVP'd users with valid email (matches current behavior)
        const emailUpdateRecipients = rsvpUsers.filter(user => {
          const hasValidEmail = user.email && !user.email.includes('@auth0.local') && !user.email.includes('@auth0');
          return hasValidEmail && user.email_notifications_enabled !== false;
        });

        // SMS recipients: RSVP'd users with SMS enabled
        const smsUpdateRecipients = rsvpUsers.filter(user => user.sms_enabled && user.phone);

        // Merge (same dedup pattern as event creation)
        const updateRecipientMap = new Map();
        emailUpdateRecipients.forEach(u => updateRecipientMap.set(u.user_id, { ...u.dataValues, _emailEligible: true }));
        smsUpdateRecipients.forEach(u => {
          if (updateRecipientMap.has(u.user_id)) {
            updateRecipientMap.get(u.user_id)._smsEligible = true;
          } else {
            updateRecipientMap.set(u.user_id, { ...u.dataValues, _smsEligible: true });
          }
        });
        const updateRecipients = Array.from(updateRecipientMap.values());

        if (updateRecipients.length > 0) {
          const frontendUrl = process.env.FRONTEND_URL || process.env.AUTH0_BASE_URL || 'http://localhost:3000';
          const eventUrl = `${frontendUrl}/gameDetail?event_id=${event.id}&group_id=${event.group_id}`;
          const game = updatedEvent.Game || await Game.findByPk(event.game_id, { attributes: ['name'] });
          const group = await Group.findByPk(event.group_id, { attributes: ['name'] });

          // D-04 / BSEC-03: re-mint the single-use RSVP batch for this date-change
          // reminder. mintRsvpBatch revokes all prior active rsvp rows for each
          // (user, event) before minting the new batch, so links from the OLD
          // email stop working and only the newest batch is consumable.
          await Promise.all(
            updateRecipients
              .filter((u) => u._emailEligible && u.email)
              .map((u) =>
                mintRsvpBatch(event.id, u.user_id).catch((err) =>
                  console.error('Error re-minting RSVP single-use batch (non-fatal):', err.message)
                )
              )
          );

          const notifyPromises = notificationService.sendToMany(updateRecipients, 'event_updated', (user) => {
            const recipientTz = user.timezone || 'UTC';
            const newEventDate = new Date(start_date);

            // Format dateTime for SMS templates (recipient's timezone, 12h with TZ).
            // Email template formats its own time internally via formatEventTime12h (MAIL-04).
            const formattedNewDateTime = newEventDate.toLocaleDateString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
              timeZone: recipientTz,
              timeZoneName: 'short',
            });

            // emailParams: ONLY set for email-eligible users
            let emailParams = null;
            if (user._emailEligible && user.email) {
              const rsvpUrls = {
                yesUrl: generateRsvpUrl(frontendUrl, event.id, user.user_id, 'yes'),
                maybeUrl: generateRsvpUrl(frontendUrl, event.id, user.user_id, 'maybe'),
                noUrl: generateRsvpUrl(frontendUrl, event.id, user.user_id, 'no'),
              };

              const { html, text } = emailService.generateDateChangeEmailTemplate({
                gameName: game?.name || 'Game Session',
                groupName: group?.name || '',
                newDate: start_date,
                durationMinutes: duration_minutes || event.duration_minutes || 60,
                eventUrl,
                recipientName: user.username,
                rsvpUrls,
                timezone: recipientTz,
              });

              emailParams = {
                to: user.email,
                subject: `Date Changed: ${game?.name || 'Game Session'} - ${group?.name || ''}`,
                html,
                text,
                groupName: group?.name || ''
              };
            }

            return {
              emailParams,
              // eventId required for SentNotification logging (notificationService.js:97).
              // Update SMS does not prompt for RSVP, but logging keeps the row uniform
              // with event_created and lets future webhook flows (e.g. "still coming?"
              // confirmations) resolve the event.
              eventId: event.id,
              data: {
                eventName: game?.name || 'Game Night',
                groupName: group?.name || '',
                dateTime: formattedNewDateTime,
                eventUrl,
                rsvpPrompt: false  // update SMS does NOT include RSVP prompt
              }
            };
          });

          Promise.allSettled([notifyPromises]).catch(err => {
            console.error('Error sending update notifications (non-fatal):', err.message);
          });
        }
      } catch (dateChangeError) {
        console.error('Error sending date-change notifications (non-fatal):', dateChangeError.message);
      }
    }

    res.json(formattedEvent);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Get (or lazily generate) the event's invite token
router.get('/:event_id/invite-token', async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const event = await Event.findByPk(req.params.event_id);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Verify user is an active member of the event's group
    const hasAccess = await isActiveMember(userId, event.group_id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Lazily generate invite token if not set
    if (!event.invite_token) {
      event.invite_token = crypto.randomBytes(32).toString('hex');
      await event.save();
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.json({
      invite_token: event.invite_token,
      invite_url: `${frontendUrl}/invite/game/${event.invite_token}`,
    });
  } catch (error) {
    console.error('Error getting event invite token:', error);
    res.status(500).json({ error: error.message });
  }
});

// Public: preview event info from invite token (no auth required)
router.get('/invite-preview/:token', async (req, res) => {
  try {
    const event = await Event.findOne({
      where: { invite_token: req.params.token },
      include: [
        { model: Group, attributes: ['id', 'name'] },
        { model: Game, attributes: ['id', 'name'] },
      ],
    });

    if (!event) {
      return res.status(404).json({ error: 'Invalid invite link' });
    }

    // Check if event has already passed
    if (new Date(event.start_date) < new Date()) {
      return res.status(410).json({ error: 'This game night has already passed', expired: true });
    }

    res.json({
      game_name: event.Game?.name || 'Game TBD',
      event_date: event.start_date,
      group_name: event.Group?.name,
      event_id: event.id,
      // Phase 71.1-02 Blocker 1 fix: include group_id so the QR-join landing
      // page can build a complete `/gameDetail?event_id=X&group_id=Y` href on
      // "Go to event". Without group_id, gameDetail's `if (group_id && user?.sub)`
      // branch is skipped, groupMembers is never fetched, userScope stays
      // 'none', and the participants strip + kebab don't render. This is also
      // covered defensively by gameDetail deriving group_id from the event
      // response, but exposing it here keeps the source of truth at the API.
      group_id: event.group_id,
    });
  } catch (error) {
    console.error('Error getting event invite preview:', error);
    res.status(500).json({ error: error.message });
  }
});

// Join a game event by invite token (authenticated)
router.post('/join-game-by-token', async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const event = await Event.findOne({
      where: { invite_token: token },
      include: [{ model: Group, attributes: ['id', 'name'] }],
    });

    if (!event) {
      return res.status(404).json({ error: 'Invalid invite link' });
    }

    // Check if event has already passed
    if (new Date(event.start_date) < new Date()) {
      return res.status(410).json({ error: 'This game night has already passed', expired: true });
    }

    // CRITICAL: EventParticipation.user_id is UUID (User.id), not Auth0 string
    const dbUser = await User.findOne({ where: { user_id: userId } });
    if (!dbUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // POLL-05: race-safe participation check. Previously this was a TOCTOU
    // pair (findOne → create) — two concurrent POSTs for the same
    // (event_id, user_id) both saw "no existing row" and both tried to
    // INSERT, second INSERT 500'd on EventParticipations_event_id_user_id_key
    // unique constraint. findOrCreate uses INSERT ... ON CONFLICT DO NOTHING
    // + fallback SELECT under Postgres, so concurrent calls collapse to one
    // created row + one fallback select with `created=false`. Matches the
    // existing findOrCreate pattern in routes/users.js, routes/groups.js,
    // routes/invites.js, routes/userGames.js (idempotent upsert idiom).
    const [participation, created] = await EventParticipation.findOrCreate({
      where: { event_id: event.id, user_id: dbUser.id },
      defaults: {
        event_id: event.id,
        user_id: dbUser.id,
        is_guest: true,
      },
    });

    // Phase 71.1-02 Blocker 3 fix: arriving via game-token MUST set is_guest=true
    // on the participation row regardless of whether the row already existed.
    // Previously `is_guest: true` only landed on the INSERT path (via defaults).
    // If a former group member (whose old EventParticipation row had is_guest=false)
    // re-joined via game-token, their row stayed is_guest=false — so the Guest
    // pill never rendered for organizers viewing the event. Per CONTEXT decision
    // (project_pending_role_frozen.md → two-QR model): anyone arriving via
    // game-token IS a guest for that event, regardless of prior state.
    if (!created && participation.is_guest !== true) {
      participation.is_guest = true;
      await participation.save();
    }

    if (!created) {
      return res.json({ already_joined: true, event_id: event.id });
    }

    // EVT-08: detect re-join after admin removal. If this user has a prior
    // `remove_participant` audit-log row for this event, suppress the welcome
    // email — sending "Welcome to [event]!" right after an admin removed them
    // is the wrong tone (silent welcome-back per Phase 65 plan 01).
    // The remove-participant handler embeds the removed User.id in
    // event_snapshot.removed_user_id. Use Op.contains for JSONB containment —
    // a plain `event_snapshot: { removed_user_id: x }` would attempt full-row
    // equality on the JSONB column and never match (the snapshot also stores
    // id, group_id, game_id, etc.).
    //
    // Runs only on the create-path (created=true) — the early-return above
    // covers the existing-row case so we don't re-check audit logs needlessly.
    let isReJoinAfterRemoval = false;
    try {
      const priorRemoval = await EventAuditLog.findOne({
        where: {
          event_id: event.id,
          action: 'remove_participant',
          event_snapshot: { [Op.contains]: { removed_user_id: dbUser.id } },
        },
      });
      if (priorRemoval) {
        isReJoinAfterRemoval = true;
      }
      console.log(`[join-game-by-token] EVT-08 suppression check: event=${event.id} user=${dbUser.id} priorRemoval=${!!priorRemoval} willSuppressEmail=${isReJoinAfterRemoval}`);
    } catch (auditLookupErr) {
      // Non-fatal — if the lookup fails, default to the old behavior (email
      // fires). A failed lookup should not block the join itself.
      console.error('[join-game-by-token] EventAuditLog lookup failed (non-fatal):', auditLookupErr.message);
    }

    // Fire-and-forget confirmation email (do not block on send) — MAIL-03
    // Only reached on a brand-new participation; the existing already_joined
    // early-return above means returning users do not get a duplicate receipt.
    // EVT-08: skipped entirely on re-join after a prior admin removal —
    // silent welcome-back, see Phase 65 plan 01.
    if (isReJoinAfterRemoval) {
      return res.json({ success: true, event_id: event.id, group_id: event.group_id });
    }

    (async () => {
      try {
        // Refetch the user with all the fields we need for the email render.
        // BSEC-01 (D-03): withContactInfo — reads fullUser.email to send the
        // game-join confirmation email.
        const fullUser = await User.scope('withContactInfo').findOne({ where: { user_id: userId } });
        if (!fullUser?.email || fullUser.email.includes('@auth0.local') || fullUser.email.includes('@auth0')) {
          return; // No real email to send to
        }
        if (fullUser.email_notifications_enabled === false) {
          return; // Master email toggle off
        }

        const game = event.game_id
          ? await Game.findByPk(event.game_id, { attributes: ['name'] })
          : null;
        const group = event.Group || await Group.findByPk(event.group_id, { attributes: ['id', 'name'] });

        // Resolve host: Event model has no `created_by` field (verified) so we
        // fall back to the group name. If/when MAIL-04 or another phase adds a
        // creator/host attribution to events, swap this to use it.
        const hostName = group?.name || 'your group';

        const frontendUrl = process.env.FRONTEND_URL || process.env.AUTH0_BASE_URL || 'http://localhost:3000';
        const eventUrl = `${frontendUrl}/gameDetail?event_id=${event.id}&group_id=${event.group_id}`;
        const recipientTz = fullUser.timezone || 'UTC';
        const startUtc = new Date(event.start_date);
        const durationMinutes = event.duration_minutes || 120;
        // Event model has no `location` field today; pass null so ICS/template
        // gracefully omit it. Future location field would be transparent.
        const location = event.location || null;
        const gameName = game?.name || 'Game Night';
        const groupName = group?.name || 'your group';

        const icsString = icsService.buildEventIcs({
          eventId: event.id,
          gameName,
          groupName,
          startUtc,
          durationMinutes,
          location,
          description: `Game night with ${groupName} on Nextgamenight. View: ${eventUrl}`,
          hostName,
          organizerEmail: 'schedule@nextgamenight.app',
        });
        const googleCalendarUrl = icsService.buildGoogleCalendarUrl({
          gameName,
          groupName,
          startUtc,
          durationMinutes,
          location: location || '',
          description: `Game night with ${groupName} on Nextgamenight.`,
        });

        await emailService.sendGameJoinConfirmation(fullUser.email, {
          gameName,
          groupName,
          eventDate: event.start_date,
          durationMinutes,
          location,
          hostName,
          recipientName: fullUser.username,
          eventUrl,
          googleCalendarUrl,
          timezone: recipientTz,
          icsAttachmentBase64: Buffer.from(icsString, 'utf-8').toString('base64'),
        });
      } catch (err) {
        console.error('[QR confirmation] non-fatal email send error:', err.message);
      }
    })();

    res.json({ success: true, event_id: event.id, group_id: event.group_id });
  } catch (error) {
    console.error('Error joining game by token:', error);
    res.status(500).json({ error: error.message });
  }
});

// Remove a single participant from an event (EVT-08, Phase 65 plan 01).
// Owner/admin only. Hard-destroys the EventParticipation row + writes an
// EventAuditLog entry with action='remove_participant' so a later QR re-join
// suppresses the welcome email (see /join-game-by-token above).
//
// :user_id is the EventParticipation.user_id (UUID = User.id), NOT Auth0
// string. Hard-destroy chosen over soft-delete because the unique index on
// (event_id, user_id) would block re-join, and EventAuditLog already provides
// the audit trail.
router.delete('/:event_id/participations/:user_id', validateUUID('event_id'), validateUUID('user_id'), async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { event_id, user_id: participationUserId } = req.params;

    const event = await Event.findByPk(event_id);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Phase 71.1: widened from owner/admin-only to also allow self-leave.
    // A game-only participant (and any group member, for that matter) must
    // be able to remove their own EventParticipation row — this is the
    // hard "I'm not coming, take me off the list" symmetric with QR-join.
    // Resolve the caller's User UUID first because participationUserId is
    // the User.id UUID (matches EventParticipation.user_id).
    const callerDbUser = await User.findOne({ where: { user_id: userId } });
    const isSelf = !!(callerDbUser && callerDbUser.id === participationUserId);
    const isOrganizer = await isOwnerOrAdmin(userId, event.group_id);
    if (!isSelf && !isOrganizer) {
      return res.status(403).json({
        error: 'You can only remove yourself or, as an admin, remove others',
      });
    }

    const participation = await EventParticipation.findOne({
      where: { event_id, user_id: participationUserId },
    });
    if (!participation) {
      return res.status(404).json({ error: 'Participation not found' });
    }

    // Phase 71.1-02: cascade RSVP / brings / ballot votes for this user on
    // this event via the shared helper (also used by PUT /:id Edit Event).
    // Wrap participation destroy + cascade in one transaction so the
    // membership removal and side-row cleanup are atomic.
    await sequelize.transaction(async (t) => {
      await participation.destroy({ transaction: t });
      await cascadeRemoveUserFromEvent({
        event_id,
        userUuid: participationUserId,
        transaction: t,
      });
    });

    // Audit-log write — non-fatal, never block the destroy.
    // suppressed_email is moot here (we don't send any email on this action),
    // recorded as false. was_after_start / was_within_15min_grace use the
    // same comparisons as the delete-event handler so reports stay consistent.
    try {
      const removeNowMs = Date.now();
      const startMs = event.start_date ? new Date(event.start_date).getTime() : 0;
      const wasAfterStart = startMs > 0 && removeNowMs >= startMs;
      const wasWithin15MinGrace = wasAfterStart && removeNowMs < startMs + FIFTEEN_MIN_MS;

      await EventAuditLog.create({
        event_id: event.id,
        group_id: event.group_id,
        actor_user_id: userId,
        action: 'remove_participant',
        was_after_start: wasAfterStart,
        was_within_15min_grace: wasWithin15MinGrace,
        suppressed_email: false,
        event_snapshot: {
          id: event.id,
          group_id: event.group_id,
          game_id: event.game_id,
          start_date: event.start_date,
          duration_minutes: event.duration_minutes,
          location: event.location || null,
          comments: event.comments || null,
          removed_user_id: participationUserId,
        },
      });
    } catch (auditErr) {
      console.error('[events:remove-participant] audit log write failed (non-fatal):', auditErr.message);
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Error removing participant:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete event
router.delete('/:id', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const event = await Event.findByPk(req.params.id);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    // Check if user is owner or admin of the group
    const hasPermission = await isOwnerOrAdmin(userId, event.group_id);
    if (!hasPermission) {
      return res.status(403).json({ error: 'Only group owners and admins can delete events' });
    }

    // MAIL-05 cancellation lifecycle gate: cancellation emails fire only when
    // now < start_time + 15min (covers the "oops, no one showed" case).
    // After that window, the delete is silent (no email, no in-app notice).
    // Audit log is written REGARDLESS of timing — see below.
    const deleteNowMs = Date.now();
    const startMs = event.start_date ? new Date(event.start_date).getTime() : 0;
    const cancellationEmailsAllowed = startMs === 0 || deleteNowMs < startMs + FIFTEEN_MIN_MS;
    const wasAfterStart = startMs > 0 && deleteNowMs >= startMs;
    const wasWithin15MinGrace = wasAfterStart && deleteNowMs < startMs + FIFTEEN_MIN_MS;
    const suppressedEmail = !cancellationEmailsAllowed;

    if (cancellationEmailsAllowed) {
      // Send cancellation notifications to members who RSVPed yes or maybe (before deleting data)
      try {
        const rsvpMembers = await EventRsvp.findAll({
          where: {
            event_id: event.id,
            status: { [Op.in]: ['yes', 'maybe'] },
          },
          include: [{
            model: User,
            attributes: ['id', 'user_id', 'username', 'email', 'email_notifications_enabled', 'sms_enabled', 'phone', 'phone_verified', 'notification_preferences'],
          }],
        });

        const rsvpUsers = rsvpMembers.filter(r => r.User).map(r => r.User);

        // Email recipients: RSVP'd users with valid email (matches current behavior)
        const emailCancelRecipients = rsvpUsers.filter(user => {
          const hasValidEmail = user.email && !user.email.includes('@auth0.local') && !user.email.includes('@auth0');
          return hasValidEmail && user.email_notifications_enabled !== false;
        });

        // SMS recipients: RSVP'd users with SMS enabled
        const smsCancelRecipients = rsvpUsers.filter(user => user.sms_enabled && user.phone);

        // Merge (same dedup pattern)
        const cancelRecipientMap = new Map();
        emailCancelRecipients.forEach(u => cancelRecipientMap.set(u.user_id, { ...u.dataValues, _emailEligible: true }));
        smsCancelRecipients.forEach(u => {
          if (cancelRecipientMap.has(u.user_id)) {
            cancelRecipientMap.get(u.user_id)._smsEligible = true;
          } else {
            cancelRecipientMap.set(u.user_id, { ...u.dataValues, _smsEligible: true });
          }
        });
        const cancellationRecipients = Array.from(cancelRecipientMap.values());

        if (cancellationRecipients.length > 0) {
          const frontendUrl = process.env.FRONTEND_URL || process.env.AUTH0_BASE_URL || 'http://localhost:3000';
          const game = await Game.findByPk(event.game_id, { attributes: ['name'] });
          const group = await Group.findByPk(event.group_id, { attributes: ['id', 'name'] });
          const groupUrl = `${frontendUrl}/groupHomePage?id=${group?.id || event.group_id}`;

          const notifyPromises = notificationService.sendToMany(cancellationRecipients, 'event_cancelled', (user) => {
            const recipientTz = user.timezone || 'UTC';
            const cancelDate = new Date(event.start_date);

            // Format dateTime for SMS templates (recipient's timezone, 12h with TZ).
            const formattedCancelDateTime = cancelDate.toLocaleDateString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
              timeZone: recipientTz,
              timeZoneName: 'short',
            });

            // emailParams: ONLY set for email-eligible users
            let emailParams = null;
            if (user._emailEligible && user.email) {
              const { html, text } = emailService.generateCancellationEmailTemplate({
                gameName: game?.name || 'Game Session',
                groupName: group?.name || '',
                eventDate: event.start_date,
                recipientName: user.username,
                groupUrl,
                timezone: recipientTz,
              });

              emailParams = {
                to: user.email,
                subject: `Cancelled: ${game?.name || 'Game Session'} - ${group?.name || ''}`,
                html,
                text,
                groupName: group?.name || ''
              };
            }

            return {
              emailParams,
              // eventId required for SentNotification logging (notificationService.js:97).
              // Cancellation rows will be filtered out by the webhook lookup (which
              // excludes cancelled events), but writing them keeps dispatch logic
              // uniform across the three event-lifecycle SMS types.
              eventId: event.id,
              data: {
                eventName: game?.name || 'Game Night',
                groupName: group?.name || '',
                dateTime: formattedCancelDateTime,
                rsvpPrompt: false  // cancellation SMS does NOT include RSVP prompt
              }
            };
          });

          // Fire-and-forget: don't block deletion on notification sends
          Promise.allSettled([notifyPromises]).catch(err => {
            console.error('Error sending cancellation notifications (non-fatal):', err.message);
          });
        }
      } catch (cancelNotifyError) {
        console.error('Error sending cancellation notifications (non-fatal):', cancelNotifyError.message);
      }
    }

    // MAIL-05 audit log: write a row for EVERY delete, regardless of timing.
    // This is OUTSIDE the cancellationEmailsAllowed guard intentionally —
    // silent late-deletes still need to be answerable by support.
    // Non-fatal: never block the delete on audit log failure.
    try {
      await EventAuditLog.create({
        event_id: event.id,
        group_id: event.group_id,
        actor_user_id: userId,
        action: 'delete',
        was_after_start: wasAfterStart,
        was_within_15min_grace: wasWithin15MinGrace,
        suppressed_email: suppressedEmail,
        event_snapshot: {
          id: event.id,
          group_id: event.group_id,
          game_id: event.game_id,
          start_date: event.start_date,
          duration_minutes: event.duration_minutes,
          location: event.location || null,
          comments: event.comments || null,
        },
      });
    } catch (auditErr) {
      console.error('[events:delete] audit log write failed (non-fatal):', auditErr.message);
    }

    // Phase 75 / GCAL-01 (Plan 75-03): enqueue per-attendee GCal cleanup jobs
    // BEFORE destroying EventParticipation rows -- the jobs need to read the
    // google_calendar_event_id off those rows, which is gone after destroy.
    // Best-effort + non-blocking: gcalCleanupService swallows enqueue errors
    // internally, but we still wrap in try/catch as defense-in-depth so a
    // require/throw at module load can't kill the delete.
    try {
      const { enqueueCleanupJobsForEvent } = require('../services/gcalCleanupService');
      const cleanupCounters = await enqueueCleanupJobsForEvent({ eventId: event.id });
      console.log(
        `[events:delete] Enqueued ${cleanupCounters.enqueued} GCal cleanup jobs ` +
        `(${cleanupCounters.skipped} skipped null, ${cleanupCounters.errors || 0} enqueue errors)`
      );
    } catch (gcalEnqueueErr) {
      console.error('[events:delete] GCal cleanup enqueue failed (non-fatal):', gcalEnqueueErr.message);
    }

    // Phase 87 (BINT-01, T-87-08-02): wrap the three destructive writes in ONE
    // managed transaction so a partial-delete failure cannot leave a half-deleted
    // event graph (e.g. RSVPs gone but the Event row surviving). The pre-delete
    // notification fanout, EventAuditLog write, and GCal cleanup enqueue above
    // stay best-effort OUTSIDE this transaction (they each have their own
    // non-fatal try/catch and must not be rolled back — the GCal enqueue in
    // particular must run BEFORE the participation destroy since it reads
    // google_calendar_event_id off those rows).
    await sequelize.transaction(async (t) => {
      // Delete RSVPs for this event
      await EventRsvp.destroy({ where: { event_id: event.id }, transaction: t });

      // Delete participations
      await EventParticipation.destroy({ where: { event_id: event.id }, transaction: t });

      // Delete event
      await event.destroy({ transaction: t });
    });

    res.json({ message: 'Event deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


module.exports = router;