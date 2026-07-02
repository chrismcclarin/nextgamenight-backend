// routes/groupPromptSettings.js
const express = require('express');
const crypto = require('crypto');
const { Group, User, UserGroup, GroupPromptSettings, Game, sequelize } = require('../models');
const { isOwnerOrAdmin, isActiveMember } = require('../services/authorizationService');
const {
  upsertSinglePromptScheduler,
  removePromptScheduler
} = require('../schedulers/promptScheduler');
const router = express.Router();

/**
 * Best-effort BullMQ sync hook. Wraps a sync action so any Redis/BullMQ
 * failure is logged but doesn't fail the HTTP response — the boot-time
 * sync + reconcile pass will recover any missed registrations.
 */
async function syncToBullMQ(action, label) {
  try {
    await action();
  } catch (err) {
    console.error(`[groupPromptSettings] BullMQ sync failed (${label}):`, err.message);
  }
}

// Helper function to generate template name from schedule data
const generateTemplateName = async (scheduleData, game_id = null) => {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = dayNames[scheduleData.schedule_day_of_week] || 'Unknown';
  const time = scheduleData.schedule_time || '00:00';

  let gameName = 'Game Session';
  if (game_id) {
    const game = await Game.findByPk(game_id);
    if (game) {
      gameName = game.name;
    }
  }

  return `${gameName} - ${dayName} ${time}`;
};

/**
 * GET /api/groups/:group_id/prompt-settings
 * Returns GroupPromptSettings for group, including schedules from template_config
 */
router.get('/:group_id/prompt-settings', async (req, res) => {
  try {
    const { group_id } = req.params;
    const userId = req.user?.user_id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify group exists
    const group = await Group.findByPk(group_id);

    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Verify user is a group member
    const isMember = await isActiveMember(userId, group_id);
    if (!isMember) {
      return res.status(403).json({ error: 'You must be a group member to view prompt settings' });
    }

    // Get prompt settings (or return default structure)
    let settings = await GroupPromptSettings.findOne({ where: { group_id } });

    // Filter out soft-deleted schedules
    let schedules = [];
    if (settings?.template_config?.schedules) {
      schedules = settings.template_config.schedules.filter(s => s.is_active !== false || s.deleted_at === undefined);
    }

    // Get group's games for dropdown selection
    // Games associated with the group through events
    const groupGames = await Game.findAll({
      include: [{
        model: require('../models').Event,
        where: { group_id },
        attributes: [],
        required: true
      }],
      attributes: ['id', 'name', 'image_url', 'min_players', 'max_players']
    });

    // Auto-clear game_id for schedules referencing deleted games
    const scheduleGameIds = [...new Set(schedules.filter(s => s.game_id).map(s => s.game_id))];
    let schedulesCleaned = false;
    if (scheduleGameIds.length > 0) {
      const existingGames = await Game.findAll({
        where: { id: scheduleGameIds },
        attributes: ['id']
      });
      const existingGameIds = new Set(existingGames.map(g => g.id));

      schedules = schedules.map(s => {
        if (s.game_id && !existingGameIds.has(s.game_id)) {
          // Game was deleted from DB - clear reference
          schedulesCleaned = true;
          return { ...s, game_id: null, updated_at: new Date().toISOString() };
        }
        return s;
      });

      // Persist cleanup if any schedules were modified
      if (schedulesCleaned && settings) {
        const allSchedules = settings.template_config?.schedules || [];
        const updatedAll = allSchedules.map(s => {
          if (s.game_id && !existingGameIds.has(s.game_id) && !s.deleted_at) {
            return { ...s, game_id: null, updated_at: new Date().toISOString() };
          }
          return s;
        });
        await settings.update({
          template_config: { ...settings.template_config, schedules: updatedAll }
        });
      }
    }

    // Get group members for recipient selection
    const groupMembers = await UserGroup.findAll({
      where: { group_id, status: 'active' },
      include: [{
        model: User,
        // BSEC-01 (D-03): email removed — username is allowNull:false so the
        // email display-name fallback was dead; drop it to user_id instead.
        attributes: ['id', 'username'],
      }],
    });

    const members = groupMembers.map(ug => ({
      id: ug.User?.id,
      user_id: ug.user_id,
      username: ug.User?.username,
      display_name: ug.User?.username || ug.user_id,
    }));

    res.json({
      id: settings?.id || null,
      group_id,
      schedule_timezone: settings?.schedule_timezone || 'UTC',
      default_deadline_hours: settings?.default_deadline_hours || 72,
      default_token_expiry_hours: settings?.default_token_expiry_hours || 168,
      is_active: settings?.is_active ?? true,
      template_config: settings?.template_config || { schedules: [] },
      schedules: schedules.filter(s => !s.deleted_at), // Only return non-deleted schedules
      games: groupGames || [],
      members: members || []
    });
  } catch (error) {
    console.error('Error getting prompt settings:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/groups/:group_id/prompt-settings/schedules
 * Create new schedule entry in template_config.schedules array
 */
router.post('/:group_id/prompt-settings/schedules', async (req, res) => {
  try {
    const { group_id } = req.params;
    const userId = req.user?.user_id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify group exists
    const group = await Group.findByPk(group_id);
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Verify user is owner or admin
    const hasPermission = await isOwnerOrAdmin(userId, group_id);
    if (!hasPermission) {
      return res.status(403).json({ error: 'Only owners and admins can create schedules' });
    }

    // Validate required fields
    const {
      schedule_day_of_week,
      schedule_time,
      schedule_timezone,
      game_id,
      template_name,
      default_deadline_hours,
      default_token_expiry_hours,
      min_participants,
      selected_member_ids
    } = req.body;

    if (schedule_day_of_week === undefined || schedule_day_of_week === null) {
      return res.status(400).json({ error: 'schedule_day_of_week is required (0-6)' });
    }
    if (schedule_day_of_week < 0 || schedule_day_of_week > 6) {
      return res.status(400).json({ error: 'schedule_day_of_week must be 0-6' });
    }
    if (!schedule_time) {
      return res.status(400).json({ error: 'schedule_time is required (HH:MM format)' });
    }
    if (!schedule_timezone) {
      return res.status(400).json({ error: 'schedule_timezone is required' });
    }

    // Generate template name if not provided (read-only; done before the txn to
    // minimize how long we hold the FOR UPDATE row lock).
    const finalTemplateName = template_name || await generateTemplateName(
      { schedule_day_of_week, schedule_time },
      game_id
    );

    // Create new schedule object
    const newSchedule = {
      id: crypto.randomUUID(),
      schedule_day_of_week,
      schedule_time,
      schedule_timezone,
      game_id: game_id || null,
      template_name: finalTemplateName,
      default_deadline_hours: default_deadline_hours || 72,
      default_token_expiry_hours: default_token_expiry_hours || 168,
      min_participants: min_participants || null,
      selected_member_ids: selected_member_ids || [],
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    // BINT-01 (T-87-09): serialize concurrent editors of this group's
    // template_config.schedules JSONB array. Two admins adding schedules at once
    // must both persist — so read-modify-write the whole array under a FOR UPDATE
    // row lock inside a managed transaction. syncToBullMQ runs AFTER commit so a
    // rollback can't desync BullMQ from the DB (T-87-10).
    //
    // Find or create GroupPromptSettings.
    //
    // Phase 71.2 / D-SCHEMA-06: when the row is first created (i.e., this is the
    // first schedule for the group), stamp `created_by_user_id` with the requester's
    // User.id (UUID) so Plan 02's close-notification recipient resolution can route
    // auto-prompt close emails to the schedule creator (rule:
    // settings.created_by_user_id || group owner). For groups with an existing
    // GroupPromptSettings row, the column stays at whatever it was (NULL for legacy
    // rows, or the original setter for rows created post-migration). Per-schedule
    // creator-tracking lives inside template_config.schedules[].created_by_user_id
    // below.
    const t = await sequelize.transaction();
    let settings;
    try {
      settings = await GroupPromptSettings.findOne({
        where: { group_id },
        transaction: t,
        lock: t.LOCK.UPDATE
      });
      if (!settings) {
        const dbUser = await User.findOne({ where: { user_id: userId }, transaction: t });
        if (!dbUser) {
          await t.rollback();
          return res.status(404).json({ error: 'User record not found' });
        }
        settings = await GroupPromptSettings.create({
          group_id,
          schedule_timezone,
          template_config: { schedules: [] },
          created_by_user_id: dbUser.id
        }, { transaction: t });
      }

      // Add to schedules array (read-modify-write pattern). Write the WHOLE
      // recomputed template_config object — nested-path JSONB merges are unreliable
      // in Sequelize.
      const currentSchedules = settings.template_config?.schedules || [];
      const updatedSchedules = [...currentSchedules, newSchedule];

      await settings.update({
        template_config: {
          ...settings.template_config,
          schedules: updatedSchedules
        }
      }, { transaction: t });

      await t.commit();
    } catch (txErr) {
      if (!t.finished) await t.rollback();
      throw txErr;
    }

    // Register the new schedule with BullMQ, AFTER commit. Schedule is
    // is_active=true on creation so we always upsert (skipped only if top-level
    // settings.is_active is false, which means the group has paused prompts
    // entirely).
    if (settings.is_active !== false) {
      await syncToBullMQ(
        () => upsertSinglePromptScheduler(settings, newSchedule),
        `POST schedule ${newSchedule.id}`
      );
    }

    res.status(201).json({
      message: 'Schedule created successfully',
      schedule: newSchedule
    });
  } catch (error) {
    console.error('Error creating schedule:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/groups/:group_id/prompt-settings/schedules/:schedule_id
 * Update existing schedule in template_config.schedules array
 */
router.patch('/:group_id/prompt-settings/schedules/:schedule_id', async (req, res) => {
  try {
    const { group_id, schedule_id } = req.params;
    const userId = req.user?.user_id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify group exists
    const group = await Group.findByPk(group_id);
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Verify user is owner or admin
    const hasPermission = await isOwnerOrAdmin(userId, group_id);
    if (!hasPermission) {
      return res.status(403).json({ error: 'Only owners and admins can update schedules' });
    }

    // Validate day_of_week if provided
    if (req.body.schedule_day_of_week !== undefined) {
      if (req.body.schedule_day_of_week < 0 || req.body.schedule_day_of_week > 6) {
        return res.status(400).json({ error: 'schedule_day_of_week must be 0-6' });
      }
    }

    // BINT-01 (T-87-09): serialize concurrent editors of this group's schedules
    // JSONB array under a FOR UPDATE row lock inside a managed transaction.
    const t = await sequelize.transaction();
    let settings;
    let updatedSchedule;
    try {
      // Get settings with FOR UPDATE lock
      settings = await GroupPromptSettings.findOne({
        where: { group_id },
        transaction: t,
        lock: t.LOCK.UPDATE
      });
      if (!settings) {
        await t.rollback();
        return res.status(404).json({ error: 'Prompt settings not found' });
      }

      // Find schedule in array
      const schedules = settings.template_config?.schedules || [];
      const scheduleIndex = schedules.findIndex(s => s.id === schedule_id);

      if (scheduleIndex === -1) {
        await t.rollback();
        return res.status(404).json({ error: 'Schedule not found' });
      }

      // BSEC-01 / D-05C: explicit key allow-list for the JSONB schedule merge.
      // A raw body spread is a mass-assignment sink — a client could
      // inject arbitrary keys into the template_config.schedules JSONB blob.
      // Sequelize `fields:` does NOT apply here (the whole template_config is one
      // JSONB column), so we pick by key. This list is the UNION of every field
      // EVERY downstream consumer reads, NOT just the write line:
      //   (a) the re-register/unregister branch below (:354-357) reads
      //       is_active + deleted_at,
      //   (b) upsertSinglePromptScheduler reads schedule_day_of_week,
      //       schedule_time, schedule_timezone, game_id, default_deadline_hours,
      //       default_token_expiry_hours, min_participants, selected_member_ids,
      //   (c) the legit user-editable schedule shape (create path) adds
      //       template_name.
      // Omitting any field a consumer reads would silently mis-schedule the job
      // or fire the wrong branch. id/updated_at stay server-managed.
      const SCHEDULE_USER_FIELDS = [
        'schedule_day_of_week',
        'schedule_time',
        'schedule_timezone',
        'game_id',
        'template_name',
        'default_deadline_hours',
        'default_token_expiry_hours',
        'min_participants',
        'selected_member_ids',
        'is_active',
        'deleted_at'
      ];
      const allowedUpdates = {};
      for (const key of SCHEDULE_USER_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(req.body, key)) {
          allowedUpdates[key] = req.body[key];
        }
      }

      // Merge updates
      updatedSchedule = {
        ...schedules[scheduleIndex],
        ...allowedUpdates,
        id: schedule_id, // Preserve original ID
        updated_at: new Date().toISOString()
      };

      // Update schedules array — write the WHOLE recomputed template_config object.
      const updatedSchedules = [...schedules];
      updatedSchedules[scheduleIndex] = updatedSchedule;

      await settings.update({
        template_config: {
          ...settings.template_config,
          schedules: updatedSchedules
        }
      }, { transaction: t });

      await t.commit();
    } catch (txErr) {
      if (!t.finished) await t.rollback();
      throw txErr;
    }

    // Re-register or unregister depending on the post-update state, AFTER commit.
    const stillActive = updatedSchedule.is_active !== false
      && !updatedSchedule.deleted_at
      && settings.is_active !== false;
    if (stillActive) {
      await syncToBullMQ(
        () => upsertSinglePromptScheduler(settings, updatedSchedule),
        `PATCH schedule ${schedule_id}`
      );
    } else {
      await syncToBullMQ(
        () => removePromptScheduler(settings.id, schedule_id),
        `PATCH (deactivate) schedule ${schedule_id}`
      );
    }

    res.json({
      message: 'Schedule updated successfully',
      schedule: updatedSchedule
    });
  } catch (error) {
    console.error('Error updating schedule:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/groups/:group_id/prompt-settings/schedules/:schedule_id
 * Soft delete: set is_active: false and deleted_at timestamp
 */
router.delete('/:group_id/prompt-settings/schedules/:schedule_id', async (req, res) => {
  try {
    const { group_id, schedule_id } = req.params;
    const userId = req.user?.user_id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify group exists
    const group = await Group.findByPk(group_id);
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Verify user is owner or admin
    const hasPermission = await isOwnerOrAdmin(userId, group_id);
    if (!hasPermission) {
      return res.status(403).json({ error: 'Only owners and admins can delete schedules' });
    }

    // BINT-01 (T-87-09): serialize concurrent editors of this group's schedules
    // JSONB array under a FOR UPDATE row lock inside a managed transaction.
    const t = await sequelize.transaction();
    let settings;
    try {
      // Get settings with FOR UPDATE lock
      settings = await GroupPromptSettings.findOne({
        where: { group_id },
        transaction: t,
        lock: t.LOCK.UPDATE
      });
      if (!settings) {
        await t.rollback();
        return res.status(404).json({ error: 'Prompt settings not found' });
      }

      // Find schedule in array
      const schedules = settings.template_config?.schedules || [];
      const scheduleIndex = schedules.findIndex(s => s.id === schedule_id);

      if (scheduleIndex === -1) {
        await t.rollback();
        return res.status(404).json({ error: 'Schedule not found' });
      }

      // Soft delete: mark as inactive and add deleted_at. Write the WHOLE
      // recomputed template_config object.
      const updatedSchedules = [...schedules];
      updatedSchedules[scheduleIndex] = {
        ...updatedSchedules[scheduleIndex],
        is_active: false,
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      await settings.update({
        template_config: {
          ...settings.template_config,
          schedules: updatedSchedules
        }
      }, { transaction: t });

      await t.commit();
    } catch (txErr) {
      if (!t.finished) await t.rollback();
      throw txErr;
    }

    // Always remove from BullMQ on delete (soft or otherwise), AFTER commit —
    // worker has an idempotent no-op for the race where a job fires after we've
    // removed the scheduler but the schedule reappears via reconcile.
    await syncToBullMQ(
      () => removePromptScheduler(settings.id, schedule_id),
      `DELETE schedule ${schedule_id}`
    );

    res.json({
      message: 'Schedule deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting schedule:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/groups/:group_id/prompt-settings/schedules/:schedule_id/toggle
 * Toggle is_active status (pause/resume schedule)
 */
router.patch('/:group_id/prompt-settings/schedules/:schedule_id/toggle', async (req, res) => {
  try {
    const { group_id, schedule_id } = req.params;
    const userId = req.user?.user_id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify group exists
    const group = await Group.findByPk(group_id);
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Verify user is owner or admin
    const hasPermission = await isOwnerOrAdmin(userId, group_id);
    if (!hasPermission) {
      return res.status(403).json({ error: 'Only owners and admins can toggle schedules' });
    }

    // BINT-01 (T-87-09): serialize concurrent editors of this group's schedules
    // JSONB array under a FOR UPDATE row lock inside a managed transaction.
    const t = await sequelize.transaction();
    let settings;
    let toggled;
    let currentActive;
    try {
      // Get settings with FOR UPDATE lock
      settings = await GroupPromptSettings.findOne({
        where: { group_id },
        transaction: t,
        lock: t.LOCK.UPDATE
      });
      if (!settings) {
        await t.rollback();
        return res.status(404).json({ error: 'Prompt settings not found' });
      }

      // Find schedule in array
      const schedules = settings.template_config?.schedules || [];
      const scheduleIndex = schedules.findIndex(s => s.id === schedule_id);

      if (scheduleIndex === -1) {
        await t.rollback();
        return res.status(404).json({ error: 'Schedule not found' });
      }

      // Check if schedule was soft-deleted
      if (schedules[scheduleIndex].deleted_at) {
        await t.rollback();
        return res.status(400).json({ error: 'Cannot toggle a deleted schedule' });
      }

      // Toggle is_active status. Write the WHOLE recomputed template_config object.
      const updatedSchedules = [...schedules];
      currentActive = updatedSchedules[scheduleIndex].is_active ?? true;
      updatedSchedules[scheduleIndex] = {
        ...updatedSchedules[scheduleIndex],
        is_active: !currentActive,
        updated_at: new Date().toISOString()
      };

      await settings.update({
        template_config: {
          ...settings.template_config,
          schedules: updatedSchedules
        }
      }, { transaction: t });

      await t.commit();
      toggled = updatedSchedules[scheduleIndex];
    } catch (txErr) {
      if (!t.finished) await t.rollback();
      throw txErr;
    }

    // Toggle: branch on the new is_active state, AFTER commit.
    const nowActive = toggled.is_active === true && settings.is_active !== false;
    if (nowActive) {
      await syncToBullMQ(
        () => upsertSinglePromptScheduler(settings, toggled),
        `TOGGLE-on schedule ${schedule_id}`
      );
    } else {
      await syncToBullMQ(
        () => removePromptScheduler(settings.id, schedule_id),
        `TOGGLE-off schedule ${schedule_id}`
      );
    }

    res.json({
      message: `Schedule ${!currentActive ? 'activated' : 'paused'} successfully`,
      schedule: toggled
    });
  } catch (error) {
    console.error('Error toggling schedule:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
