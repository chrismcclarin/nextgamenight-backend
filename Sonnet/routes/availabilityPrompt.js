// routes/availabilityPrompt.js
// Routes for availability prompt management: respondent tracking and reminders

const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const { verifyAuth0Token } = require('../middleware/auth0');
const {
  AvailabilityPrompt,
  AvailabilityResponse,
  User,
  UserGroup,
  Group,
  Game,
  GroupPromptSettings
} = require('../models');
const emailService = require('../services/emailService');
const { scheduleReminders, scheduleDeadlineJob } = require('../services/reminderService');

/**
 * GET /api/prompts/:promptId/respondents
 * Get list of all group members with their response status for a prompt
 *
 * Protected by Auth0 token
 * Returns: Array of { user_id, username, has_responded, slot_count, submitted_at, last_reminded_at }
 *
 * For blind voting:
 * - Admins see who responded (not slot details)
 * - Non-admins see only their own status before submitting
 */
router.get('/prompts/:promptId/respondents', verifyAuth0Token, async (req, res) => {
  try {
    const { promptId } = req.params;
    const userId = req.user.user_id;

    // 1. Get prompt with group
    const prompt = await AvailabilityPrompt.findByPk(promptId, {
      include: [{ model: Group }]
    });

    if (!prompt) {
      return res.status(404).json({ error: 'Prompt not found' });
    }

    // 2. Verify requester is a member of the group
    const requesterGroup = await UserGroup.findOne({
      where: { group_id: prompt.group_id, user_id: userId, status: 'active' }
    });

    if (!requesterGroup) {
      return res.status(403).json({ error: 'You must be a member of this group' });
    }

    const isAdmin = ['owner', 'admin'].includes(requesterGroup.role);

    // 3. Get all active group members
    const groupMembers = await UserGroup.findAll({
      where: { group_id: prompt.group_id, status: 'active' },
      include: [{
        model: User,
        attributes: ['user_id', 'username', 'email']
      }]
    });

    // 4. Get all responses for this prompt
    const responses = await AvailabilityResponse.findAll({
      where: { prompt_id: promptId }
    });

    // Create a map of responses by user_id
    const responseMap = new Map();
    responses.forEach(r => {
      responseMap.set(r.user_id, r);
    });

    // 5. Check if current user has responded (for blind voting visibility)
    const userHasResponded = responseMap.has(userId);
    const pollClosed = prompt.status === 'closed' || prompt.status === 'converted' ||
                       new Date(prompt.deadline) < new Date();

    // 6. Build respondent list with visibility rules
    const respondents = groupMembers.map(member => {
      const response = responseMap.get(member.user_id);
      const hasResponded = !!response && response.submitted_at !== null;

      // Calculate slot count
      let slotCount = 0;
      if (response && response.time_slots) {
        slotCount = Array.isArray(response.time_slots) ? response.time_slots.length : 0;
      }

      // Visibility for blind voting:
      // - If blind voting is enabled and poll is not closed and user hasn't responded:
      //   - Only show slot counts for admin (who can see who responded)
      //   - Non-admins only see their own data
      const showSlotCount = !prompt.blind_voting_enabled ||
                            pollClosed ||
                            userHasResponded ||
                            isAdmin ||
                            member.user_id === userId;

      return {
        user_id: member.user_id,
        username: member.User?.username || 'Unknown',
        has_responded: hasResponded,
        slot_count: showSlotCount ? slotCount : null,
        submitted_at: hasResponded ? response.submitted_at : null,
        last_reminded_at: response?.last_reminded_at || null
      };
    });

    // Sort: responded first, then alphabetically
    respondents.sort((a, b) => {
      if (a.has_responded !== b.has_responded) {
        return a.has_responded ? -1 : 1;
      }
      return (a.username || '').localeCompare(b.username || '');
    });

    res.json(respondents);

  } catch (error) {
    console.error('Error getting respondents:', error);
    res.status(500).json({ error: 'Failed to get respondents' });
  }
});


/**
 * POST /api/prompts/:promptId/remind/:userId
 * Send reminder email to a non-respondent
 *
 * Protected by Auth0 token (admin/owner only)
 * Enforces 24-hour cooldown per user
 */
router.post('/prompts/:promptId/remind/:userId', verifyAuth0Token, async (req, res) => {
  try {
    const { promptId, userId: targetUserId } = req.params;
    const userId = req.user.user_id;

    // 1. Get prompt with group and game
    const prompt = await AvailabilityPrompt.findByPk(promptId, {
      include: [
        { model: Group },
        { model: Game }
      ]
    });

    if (!prompt) {
      return res.status(404).json({ error: 'Prompt not found' });
    }

    // 2. Verify requester is admin/owner of the group
    const userGroup = await UserGroup.findOne({
      where: { group_id: prompt.group_id, user_id: userId, status: 'active' }
    });

    if (!userGroup || !['owner', 'admin'].includes(userGroup.role)) {
      return res.status(403).json({ error: 'Only admins can send reminders' });
    }

    // 3. Check if prompt is still active
    if (prompt.status !== 'active' && prompt.status !== 'pending') {
      return res.status(400).json({ error: 'Cannot send reminders for closed prompts' });
    }

    // 4. Check cooldown - find or create response record
    let response = await AvailabilityResponse.findOne({
      where: { prompt_id: promptId, user_id: targetUserId }
    });

    if (response?.last_reminded_at) {
      const hoursSince = (Date.now() - new Date(response.last_reminded_at)) / (1000 * 60 * 60);
      if (hoursSince < 24) {
        const nextAvailable = new Date(new Date(response.last_reminded_at).getTime() + 24 * 60 * 60 * 1000);
        return res.status(429).json({
          error: 'Cannot remind user more than once per 24 hours',
          next_reminder_available: nextAvailable.toISOString()
        });
      }
    }

    // 5. Check if user has already responded
    if (response?.submitted_at) {
      return res.status(400).json({ error: 'User has already submitted their availability' });
    }

    // 6. Get target user
    const targetUser = await User.findOne({ where: { user_id: targetUserId } });
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // 7. Verify target user is in the group
    const targetUserGroup = await UserGroup.findOne({
      where: { group_id: prompt.group_id, user_id: targetUserId, status: 'active' }
    });
    if (!targetUserGroup) {
      return res.status(400).json({ error: 'User is not a member of this group' });
    }

    // 8. Send reminder email
    const gameName = prompt.Game?.name || 'game night';
    const groupName = prompt.Group?.name || 'your group';
    const deadline = new Date(prompt.deadline).toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    });

    const emailResult = await emailService.send({
      to: targetUser.email,
      subject: `Reminder: ${groupName} availability request`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #4F46E5;">Availability Reminder</h2>
          <p>Hi ${targetUser.username || 'there'},</p>
          <p>This is a friendly reminder to submit your availability for the upcoming <strong>${gameName}</strong> session with <strong>${groupName}</strong>.</p>
          <p>The deadline to respond is <strong>${deadline}</strong>.</p>
          <p>Please check your email for the original availability link, or contact your group admin if you need a new one.</p>
          <p style="color: #6B7280; font-size: 12px; margin-top: 30px;">
            This is an automated reminder from NextGameNight.
          </p>
        </div>
      `,
      text: `Hi ${targetUser.username || 'there'},\n\nThis is a friendly reminder to submit your availability for the upcoming ${gameName} session with ${groupName}.\n\nThe deadline to respond is ${deadline}.\n\nPlease check your email for the original availability link, or contact your group admin if you need a new one.`,
      groupName: groupName
    });

    if (!emailResult.success) {
      console.error('Failed to send reminder email:', emailResult.error);
      return res.status(500).json({ error: 'Failed to send reminder email' });
    }

    // 9. Update or create response record with last_reminded_at
    if (response) {
      await response.update({ last_reminded_at: new Date() });
    } else {
      // Create a placeholder response record to track reminder
      await AvailabilityResponse.create({
        prompt_id: promptId,
        user_id: targetUserId,
        time_slots: [],
        user_timezone: 'UTC',
        submitted_at: null, // Not submitted yet
        last_reminded_at: new Date()
      });
    }

    res.json({
      success: true,
      message: `Reminder sent to ${targetUser.username || targetUser.email}`
    });

  } catch (error) {
    console.error('Error sending reminder:', error);
    res.status(500).json({ error: 'Failed to send reminder' });
  }
});


/**
 * POST /api/prompts
 * Manually create an availability prompt for a group
 *
 * Protected by Auth0 token (admin/owner only)
 * Body: { group_id, deadline, auto_schedule_enabled, blind_voting_enabled, week_identifier }
 *
 * Schedules reminder and deadline jobs after creation when ENABLE_WORKERS is enabled.
 */
router.post('/prompts', verifyAuth0Token, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const {
      group_id,
      deadline,
      auto_schedule_enabled,
      blind_voting_enabled,
      week_identifier,
      // Phase 71.2 / Plan 03 — manual-poll body widened to accept the
      // optional fields the StartPollModal collects. Both columns already
      // exist on AvailabilityPrompt (see models/AvailabilityPrompt.js).
      // Without these reads the modal's custom_message + game_id would
      // silently drop, defeating the form's purpose.
      custom_message,
      game_id
    } = req.body;

    if (!group_id) {
      return res.status(400).json({ error: 'group_id is required' });
    }

    if (!deadline) {
      return res.status(400).json({ error: 'deadline is required' });
    }

    // Verify group exists
    const group = await Group.findByPk(group_id);
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Phase 71.2 / D-CLOSE-06: any active group member can fire an availability
    // prompt — admin gate replaced with active-member gate. Pending and removed
    // members still receive 403.
    const userGroup = await UserGroup.findOne({
      where: { group_id, user_id: userId, status: 'active' }
    });

    if (!userGroup || userGroup.status !== 'active') {
      return res.status(403).json({ error: 'You must be an active group member to create a poll' });
    }

    // Phase 71.2 / D-SCHEMA-04: stamp the creator on manual polls. The frontend
    // body cannot supply this field — it's derived server-side from the verified
    // Auth0 sub via the User table (see threat T-71.2-05 in plan threat model).
    const dbUser = await User.findOne({ where: { user_id: userId } });
    if (!dbUser) {
      return res.status(404).json({ error: 'User record not found' });
    }

    // Create the prompt. Wrap in try/catch on UniqueConstraintError so the
    // partial unique index `availability_prompts_one_open_manual` (D-ADAPT-02)
    // surfaces as a 409 instead of a 500.
    let prompt;
    try {
      prompt = await AvailabilityPrompt.create({
        group_id,
        prompt_date: new Date(),
        deadline: new Date(deadline),
        // Phase 71.2 / Plan 03 hotfix — create manual polls as 'active' directly.
        // The 'pending → active' transition exists in workers/promptWorker.js
        // because that worker fans out emails synchronously and flips to active
        // after the loop finishes. Manual polls fan out non-blocking, so leaving
        // status='pending' would permanently reject responses (see
        // routes/availabilityResponse.js status gate). Auto-prompts still
        // transition pending → active per the worker.
        status: 'active',
        week_identifier: week_identifier || null,
        auto_schedule_enabled: auto_schedule_enabled ?? true,
        blind_voting_enabled: blind_voting_enabled ?? false,
        // Phase 71.2 / Plan 03 — optional manual-poll fields.
        custom_message: typeof custom_message === 'string' && custom_message.trim()
          ? custom_message.trim().slice(0, 280) // align with frontend 280-char limit
          : null,
        game_id: game_id || null,
        created_by_user_id: dbUser.id
      });
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') {
        // Partial unique index hit — group already has an open manual poll.
        // The path on this constraint is reported as 'group_id' by Sequelize.
        return res.status(409).json({
          error: 'This group already has an open poll. Close it before starting another.'
        });
      }
      throw err;
    }

    // Schedule reminder and deadline jobs (only if BullMQ is enabled)
    if (process.env.NODE_ENV === 'production' || process.env.ENABLE_WORKERS === 'true') {
      try {
        await scheduleDeadlineJob(prompt);
        await scheduleReminders(prompt);
      } catch (err) {
        console.error('Failed to schedule jobs for prompt:', err.message);
        // Don't fail the request - jobs can be scheduled manually or by cron
      }
    }

    // Phase 71.2 / Plan 03 hotfix — fan out invitation emails to active group
    // members so they can respond. Best-effort; failures are logged per recipient
    // and don't block the 201 response.
    try {
      const promptInvitationService = require('../services/promptInvitationService');
      // Don't await — fanout can take seconds for large groups; the client
      // already has its 201. Rely on the service's internal logging for visibility.
      promptInvitationService.notifyMembersOfPrompt(prompt).catch((err) => {
        console.error('[POST /prompts] invitation fanout error (non-fatal):', err.message);
      });
    } catch (err) {
      console.error('[POST /prompts] failed to dispatch invitation fanout:', err.message);
    }

    res.status(201).json({
      message: 'Prompt created successfully',
      prompt: {
        id: prompt.id,
        group_id: prompt.group_id,
        deadline: prompt.deadline,
        status: prompt.status,
        week_identifier: prompt.week_identifier
      }
    });

  } catch (error) {
    console.error('Error creating prompt:', error);
    res.status(500).json({ error: 'Failed to create prompt' });
  }
});


/**
 * GET /api/groups/:groupId/prompts/active
 * Get the most recent active or pending AvailabilityPrompt for a group.
 *
 * Protected by Auth0 token (group members only).
 * Returns: { prompt: <AvailabilityPrompt | null> }
 *
 * Used by the group planning page to discover the current prompt ID before
 * fetching suggestions or rendering ResponseDashboard.
 */
router.get('/groups/:groupId/prompts/active', verifyAuth0Token, async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.user.user_id; // auth0.js sets req.user.user_id = decoded.sub

    // Verify requester is a member of the group
    const userGroup = await UserGroup.findOne({
      where: { group_id: groupId, user_id: userId, status: 'active' }
    });
    if (!userGroup) {
      return res.status(403).json({ error: 'You must be a member of this group' });
    }

    // Find the most recent active or pending prompt for this group
    const prompt = await AvailabilityPrompt.findOne({
      where: {
        group_id: groupId,
        status: { [Op.in]: ['active', 'pending'] }
      },
      order: [['createdAt', 'DESC']]
    });

    res.json({ prompt: prompt || null });
  } catch (error) {
    console.error('Error fetching active prompt:', error);
    res.status(500).json({ error: 'Failed to fetch active prompt' });
  }
});


/**
 * GET /api/prompts/:promptId
 * Returns a single prompt by ID (any status). Used by groupPlanning page
 * when navigating from a no-consensus email link.
 */
router.get('/prompts/:promptId', verifyAuth0Token, async (req, res) => {
  try {
    const { promptId } = req.params;
    const { AvailabilityPrompt } = require('../models');
    const prompt = await AvailabilityPrompt.findByPk(promptId);
    if (!prompt) {
      return res.status(404).json({ error: 'Prompt not found' });
    }
    res.json({ prompt });
  } catch (error) {
    console.error('Error fetching prompt:', error);
    res.status(500).json({ error: 'Failed to fetch prompt' });
  }
});


/**
 * PATCH /api/availability-prompts/:id/close
 * Phase 71.2 / D-CLOSE-05 — Soft-close an availability prompt (manual poll OR auto-prompt).
 * Auth: prompt creator OR group owner/admin.
 * Soft close: sets status='closed', preserves all responses.
 * D-CLOSE-04: closed is final — no re-open path.
 *
 * Plan 02 will hook an after-update lifecycle handler for the close-notification
 * email + "Schedule it?" CTA. This route is intentionally thin — no email logic here.
 */
router.patch('/availability-prompts/:id/close', verifyAuth0Token, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { id } = req.params;

    const prompt = await AvailabilityPrompt.findByPk(id);
    if (!prompt) return res.status(404).json({ error: 'Poll not found' });

    if (prompt.status === 'closed' || prompt.status === 'converted') {
      // D-CLOSE-04: closed is final. Return 409 to make state-machine violations loud.
      return res.status(409).json({ error: `Poll is already ${prompt.status}` });
    }

    const dbUser = await User.findOne({ where: { user_id: userId } });
    if (!dbUser) return res.status(404).json({ error: 'User record not found' });

    const userGroup = await UserGroup.findOne({
      where: { user_id: userId, group_id: prompt.group_id, status: 'active' }
    });

    const isAdmin = !!userGroup && ['owner', 'admin'].includes(userGroup.role);
    const isCreator = prompt.created_by_user_id !== null && prompt.created_by_user_id === dbUser.id;

    if (!isAdmin && !isCreator) {
      return res.status(403).json({ error: 'Only the poll creator or a group admin can close this poll' });
    }

    await prompt.update({ status: 'closed' });

    // Phase 71.2 / D-ADAPT-04: dispatch close-notification email + Schedule it?
    // CTA via the unified lifecycle service. Best-effort — close already
    // committed, errors here are non-fatal.
    try {
      const lifecycleService = require('../services/promptLifecycleService');
      await lifecycleService.handlePromptClosed(prompt);
    } catch (notifyErr) {
      console.error('[availabilityPrompt] close-notification dispatch failed (non-fatal):', notifyErr.message);
    }

    // can_close is now false for everyone (D-CLOSE-04 — closed is final).
    res.json({ success: true, prompt, can_close: false });
  } catch (error) {
    console.error('Error closing prompt:', error);
    res.status(500).json({ error: 'Failed to close prompt' });
  }
});


/**
 * GET /api/groups/:groupId/prompts/open
 * Phase 71.2 / D-UI-02 — list ALL open AvailabilityPrompts (manual + auto) for a group,
 * with creator info, the parent recurring-schedule name (for auto-prompts via
 * GroupPromptSettings.template_name), and a per-requester `can_close` flag.
 *
 * Used by the unified open-polls list UI.
 *
 * Note on field name: the plan/CONTEXT references `GroupPromptSettings.name` (D-UI-02)
 * but the actual model column is `template_name`. We expose it as `template_name` in
 * the include payload — Plan 03 maps that to the "From [schedule name]" UI label.
 *
 * D-CLOSE-05: server-derived `can_close` flag scoped to the requester so the
 * frontend never sees raw creator UUIDs. We also strip `created_by_user_id`
 * from the wire payload (T-71.2-02 mitigation).
 */
router.get('/groups/:groupId/prompts/open', verifyAuth0Token, async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.user.user_id;

    const userGroup = await UserGroup.findOne({
      where: { group_id: groupId, user_id: userId, status: 'active' }
    });
    if (!userGroup) return res.status(403).json({ error: 'You must be a member of this group' });

    const dbUser = await User.findOne({ where: { user_id: userId } });
    if (!dbUser) return res.status(404).json({ error: 'User record not found' });
    const isAdmin = ['owner', 'admin'].includes(userGroup.role);

    const prompts = await AvailabilityPrompt.findAll({
      where: {
        group_id: groupId,
        status: { [Op.in]: ['pending', 'active'] }
      },
      include: [
        // D-SCHEMA-05 — creator info for "Started by [name]" on manual polls.
        // required:false so auto-prompts (created_by_user_id IS NULL) still come back.
        { model: User, as: 'Creator', attributes: ['id', 'username'], required: false },
        // D-UI-02 — parent recurring-schedule name for auto-prompts. The default
        // belongsTo alias is used (matches the existing AvailabilityPrompt.belongsTo
        // (GroupPromptSettings, { foreignKey: 'created_by_settings_id' }) wired in
        // models/index.js with no `as`). template_name is the model field that maps
        // to the user-facing "schedule name" referenced in the CONTEXT as `name`.
        { model: GroupPromptSettings, attributes: ['id', 'template_name'], required: false }
      ],
      order: [['createdAt', 'DESC']]
    });

    const decorated = prompts.map(p => {
      const isCreator = p.created_by_user_id !== null && p.created_by_user_id === dbUser.id;
      const can_close = isAdmin || isCreator;
      const json = p.toJSON();
      // T-71.2-02: strip raw creator UUID from the wire — UI uses can_close +
      // Creator.username only.
      delete json.created_by_user_id;
      return { ...json, can_close };
    });

    res.json({ prompts: decorated });
  } catch (error) {
    console.error('Error fetching open prompts:', error);
    res.status(500).json({ error: 'Failed to fetch open prompts' });
  }
});


module.exports = router;
