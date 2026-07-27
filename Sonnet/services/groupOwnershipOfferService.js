// services/groupOwnershipOfferService.js
//
// Phase 88.2 / SPEC-REQ-8, D-03 — Fan out the ownership-offer email to every
// remaining active member of a group that its owner has just soft-deleted.
//
// Deletion is no longer silent. Each remaining member is told the group was
// deleted, how long it is held, and how to take it over and get it all back.
//
// This module is dispatch only. It mints no token, reads no row, and touches no
// model. The caller (routes/groups.js, wired in plan 88.2-06) materializes the
// roster BEFORE the delete transaction and hands it in.

const emailService = require('./emailService');
const auth0Service = require('./auth0Service');

// Matches the precedent's fallback when a member has no profile timezone
// (services/promptInvitationService.js formatDeadlineForUser).
const FALLBACK_TIMEZONE = 'UTC';

/**
 * Format the purge deadline as a calendar DATE in the recipient's own timezone.
 * SPEC-REQ-8 asks for "the exact calendar date from purge_after" — no time of
 * day, because the recipient's actionable fact is which day it runs out.
 *
 * An unrecognized IANA timezone string makes Intl throw a RangeError. That must
 * not cost a member their notice, so the fallback is applied on throw as well as
 * on absence.
 */
function formatDeadlineForRecipient(purgeAfter, userTz) {
  if (!purgeAfter) return 'the deadline';
  const opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
  try {
    return new Date(purgeAfter).toLocaleString('en-US', { timeZone: userTz || FALLBACK_TIMEZONE, ...opts });
  } catch (err) {
    return new Date(purgeAfter).toLocaleString('en-US', { timeZone: FALLBACK_TIMEZONE, ...opts });
  }
}

/**
 * Reduce an address to its domain for logging. SPEC control V7: per-item
 * dispatch logs must carry no recipient PII (T-88.2-22).
 */
function redactEmail(email) {
  if (typeof email !== 'string') return '<no address>';
  const at = email.lastIndexOf('@');
  return at === -1 ? '<malformed address>' : `<redacted>@${email.slice(at + 1)}`;
}

/**
 * Dispatch one ownership-offer email per remaining member.
 *
 * DECISION Phase 88.2 SPEC-REQ-8: this signature takes PRIMITIVES and a
 * pre-materialized recipient array, over taking a `Group` instance or a group id
 * and querying the roster itself. That is not a style preference — by the time
 * this runs, `Group`, `UserGroup` and `Event` are all paranoid AND all stamped,
 * so any query this service made would be paranoid-filtered to zero rows and
 * silently send nothing (88.2-RESEARCH.md Pitfall 5, "zero emails sent"). Making
 * the function structurally incapable of re-querying removes the failure mode
 * instead of relying on the caller getting its ordering right forever. Do not
 * "simplify" this to accept a group handle.
 *
 * @param {Object} params
 * @param {string} params.groupName - Name of the deleted group (user-controlled)
 * @param {Date} params.purgeAfter - The group's stamped purge deadline
 * @param {string} params.restoreUrl - Fully-formed acceptance link
 * @param {Array<{email: string, username?: string, timezone?: string, user_id?: string}>} params.recipients
 *   Remaining active members, EXCLUDING the deleting owner. `user_id` is the
 *   Auth0 sub and is required for the synthetic-address backfill below.
 * @returns {Promise<{sent: number, failed: number, unreachable: number}>}
 *   Never rejects. A failing email must never fail the delete — by the time this
 *   runs the soft-delete transaction has already committed.
 */
async function sendGroupOwnershipOffers({ groupName, purgeAfter, restoreUrl, recipients }) {
  if (!emailService.isConfigured()) {
    console.warn('[groupOwnershipOffer] email service not configured; skipping ownership-offer dispatch');
    return { sent: 0, failed: 0, unreachable: 0 };
  }

  // A group whose owner was its only remaining member dispatches zero (SPEC-REQ-8).
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return { sent: 0, failed: 0, unreachable: 0 };
  }

  let sent = 0;
  let failed = 0;
  let unreachable = 0;

  try {
    for (const recipient of recipients) {
      if (!recipient || !recipient.email) {
        // No address at all, so there is nothing to look up FROM.
        unreachable++;
        continue;
      }

      let targetEmail = recipient.email;

      if (targetEmail.includes('@auth0')) {
        // DECISION Phase 88.2 MED-AUTH0: an Auth0 Management API backfill is
        // attempted here, over the blanket skip that every sibling dispatcher
        // performs (services/promptInvitationService.js:143 skips any address
        // containing '@auth0' outright). A synthetic '@auth0.local' placeholder
        // (provisioned at routes/groups.js:644) does NOT mean the person has no
        // real email — it means the UNVERIFIED copy in their token was not safe
        // to persist. Treating it as proof of unreachability silently drops a
        // member from the one notice this phase exists to deliver.
        //
        // The recovered address is used ONLY when Auth0 reports emailVerified
        // === true. Emailing an address Auth0 itself has not verified would risk
        // disclosing the group's name to a mailbox that may not belong to that
        // person (T-88.2-25). The gate is for DISCLOSURE, not link security: the
        // restore link is worthless to a non-member either way, since acceptance
        // requires an authenticated session holding a membership row stamped by
        // this deletion.
        //
        // The same blanket-skip blind spot still exists at
        // services/promptInvitationService.js:143 for availability prompts.
        // Deliberately OUT OF SCOPE for this phase — a recurring nudge has a very
        // different cost/benefit from a one-time irreversible-consequence notice.
        let recoveredEmail = null;
        try {
          const auth0User = await auth0Service.getUserById(recipient.user_id);
          // getUserById RESOLVES null on a 404 rather than rejecting, so a
          // try/catch alone does not cover this path — and extractUserDetails(null)
          // would throw a TypeError inside the loop instead of degrading. Check
          // the return value explicitly before dereferencing it.
          if (auth0User) {
            const details = auth0Service.extractUserDetails(auth0User);
            if (details && details.emailVerified === true && details.email && !details.email.includes('@auth0')) {
              recoveredEmail = details.email;
            }
          }
        } catch (err) {
          // Isolated from the send try/catch below on purpose: a Management API
          // outage degrades this one recipient to "unreachable" and can never
          // throw into, or abort, the rest of the fanout (T-88.2-26).
          console.warn(`[groupOwnershipOffer] Auth0 backfill lookup failed for a member; treating as unreachable: ${err.message}`);
          recoveredEmail = null;
        }

        if (!recoveredEmail) {
          unreachable++;
          continue;
        }
        targetEmail = recoveredEmail;
      }

      // DECISION Phase 88.2 D-03: the sibling dispatchers skip any member whose
      // email_notifications_enabled is false — services/promptInvitationService.js:144
      // has exactly that gate at exactly this point in its loop, and
      // notificationService.js:50 applies the same rule to everything routed
      // through it. That gate is DELIBERATELY OMITTED here, and this offer is
      // deliberately NOT routed through the notification service, which would
      // reimpose it.
      //
      // Why the inconsistency is load-bearing: this is a one-time notice with an
      // irreversible consequence. A member who muted game-night email would
      // otherwise lose years of history with no chance to intervene — precisely
      // the person this phase exists to protect. The preference means "stop
      // emailing me about game nights", not "destroy my group without telling me".
      //
      // Adding the gate back to make this consistent with its siblings SILENTLY
      // BREAKS the phase's core protection: nothing fails, no test about
      // preferences goes red, the emails simply never arrive. Same for routing
      // this through the notification service. Changing either is a product
      // decision, not a cleanup.

      try {
        const deadlineDate = formatDeadlineForRecipient(purgeAfter, recipient.timezone);
        const { html, text, subject } = emailService.generateGroupOwnershipOfferEmailTemplate({
          recipientName: recipient.username || 'there',
          groupName,
          deadlineDate,
          restoreUrl,
        });

        const result = await emailService.send({
          to: targetEmail,
          subject,
          html,
          text,
          groupName,
          emailType: 'group_ownership_offer',
        });

        // DECISION Phase 88.2 MED-18: a RESOLVED { success: false } counts as a
        // failure, over counting failures only in the catch below. emailService.send
        // never throws on a send failure — it catches internally and resolves
        // { success: false, error } (services/emailService.js:79-83 for a
        // Resend-returned error, :86-89 for a thrown one). With failed++ only in
        // the catch, a batch where EVERY email failed would report
        // { sent: 0, failed: 0 } and log a clean summary, which defeats D-03's
        // requirement that the residual be recorded rather than silently ignored.
        // This branch is the PRIMARY failure path; the catch is the secondary one.
        if (!result?.success) {
          failed++;
          console.error(`[groupOwnershipOffer] send failed for ${redactEmail(targetEmail)}: ${result?.error || 'unknown'}`);
        } else {
          sent++;
        }
      } catch (err) {
        // Secondary path — a genuine throw, e.g. a bug in template generation.
        failed++;
        console.error(`[groupOwnershipOffer] error sending to ${redactEmail(targetEmail)}: ${err.message}`);
      }
    }
  } catch (err) {
    // Outer guard, mirroring the sweep discipline: this function must never
    // reject. The group is already soft-deleted and committed by the time it
    // runs, so a dispatch failure must never propagate back into the delete
    // (T-88.2-21). Return the counters accumulated so far.
    console.error(`[groupOwnershipOffer] dispatch aborted early: ${err.message}`);
  }

  console.log(`[groupOwnershipOffer] dispatch complete: sent=${sent} failed=${failed} unreachable=${unreachable} of ${recipients.length} recipients`);
  if (unreachable > 0) {
    // The NARROWED D-03 residual, after the backfill attempt: members whose
    // Auth0 record is itself unverified, or whose lookup failed — not merely
    // members who happened to hold a synthetic placeholder address.
    console.warn(`[groupOwnershipOffer] ${unreachable} of ${recipients.length} remaining members could not be offered ownership (Auth0 record unverified, or Management API lookup failed)`);
  }

  return { sent, failed, unreachable };
}

module.exports = { sendGroupOwnershipOffers };
