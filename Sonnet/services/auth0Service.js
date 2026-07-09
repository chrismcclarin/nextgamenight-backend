// services/auth0Service.js
// Service for interacting with Auth0 Management API
const axios = require('axios');

class Auth0Service {
  constructor() {
    this.domain = process.env.AUTH0_DOMAIN;
    this.clientId = process.env.AUTH0_MANAGEMENT_CLIENT_ID;
    this.clientSecret = process.env.AUTH0_MANAGEMENT_CLIENT_SECRET;
    this.audience = `https://${this.domain}/api/v2/`;
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  /**
   * Get Management API access token
   * Tokens expire after 24 hours, so we cache and reuse them
   */
  async getManagementToken() {
    // Return cached token if still valid (with 5 minute buffer)
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry - 300000) {
      return this.accessToken;
    }

    if (!this.clientId || !this.clientSecret || !this.domain) {
      throw new Error('Auth0 Management API credentials not configured. Set AUTH0_MANAGEMENT_CLIENT_ID, AUTH0_MANAGEMENT_CLIENT_SECRET, and AUTH0_DOMAIN environment variables.');
    }

    try {
      const response = await axios.post(`https://${this.domain}/oauth/token`, {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        audience: this.audience,
        grant_type: 'client_credentials'
      }, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      this.accessToken = response.data.access_token;
      // Token expires in 24 hours (86400000 ms), cache for 23 hours to be safe
      this.tokenExpiry = Date.now() + (23 * 60 * 60 * 1000);

      return this.accessToken;
    } catch (error) {
      console.error('Error fetching Auth0 Management API token:', error.message);
      if (error.response) {
        console.error('Auth0 response:', error.response.data);
      }
      throw new Error(`Failed to get Auth0 Management API token: ${error.message}`);
    }
  }

  /**
   * Search for users by email in Auth0
   * Returns array of matching users
   */
  async searchUsersByEmail(email) {
    try {
      const token = await this.getManagementToken();
      
      const response = await axios.get(`https://${this.domain}/api/v2/users`, {
        params: {
          q: `email:"${email}"`,
          search_engine: 'v3'
        },
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      return response.data || [];
    } catch (error) {
      console.error('Error searching Auth0 users by email:', error.message);
      if (error.response) {
        console.error('Auth0 response:', error.response.data);
      }
      throw new Error(`Failed to search Auth0 users: ${error.message}`);
    }
  }

  /**
   * Get user by Auth0 user_id (sub)
   */
  async getUserById(userId) {
    try {
      const token = await this.getManagementToken();
      
      const response = await axios.get(`https://${this.domain}/api/v2/users/${encodeURIComponent(userId)}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      return response.data;
    } catch (error) {
      if (error.response?.status === 404) {
        return null;
      }
      console.error('Error fetching Auth0 user by ID:', error.message);
      if (error.response) {
        console.error('Auth0 response:', error.response.data);
      }
      throw new Error(`Failed to fetch Auth0 user: ${error.message}`);
    }
  }

  /**
   * Delete an Auth0 login identity by user_id (sub).
   * Molded on getUserById: acquire the cached client-credentials Management token,
   * issue DELETE /api/v2/users/:encodedSub, treat 204 as success and 404 as
   * already-deleted (idempotent). Any other status throws so the caller's durable
   * retry lane (accountDeletionService / auth0CleanupWorker) engages — this method
   * NEVER swallows a 401/403/429/5xx.
   *
   * Requires the delete:users scope on the Management client (provisioned as a gated
   * human dashboard step in plan 87.2-09, not code-provisioned).
   */
  async deleteUser(userId) {
    const token = await this.getManagementToken();
    try {
      await axios.delete(`https://${this.domain}/api/v2/users/${encodeURIComponent(userId)}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });
      return { deleted: true }; // 204 No Content on success
    } catch (error) {
      if (error.response?.status === 404) {
        return { deleted: true, alreadyGone: true }; // idempotent — already deleted
      }
      console.error('Error deleting Auth0 user:', error.message);
      if (error.response) {
        console.error('Auth0 response:', error.response.data);
      }
      // Rethrow (wrapped) so the enqueue/retry path fires on 401/403/429/5xx.
      throw new Error(`Failed to delete Auth0 user: ${error.message}`);
    }
  }

  /**
   * Extract user details from Auth0 user object
   * Handles both Google OAuth and email/password users
   * 
   * For email/password users: username field contains what they entered during signup
   * For Google OAuth users: name field contains their Google name
   */
  extractUserDetails(auth0User) {
    const email = auth0User.email;
    const emailVerified = auth0User.email_verified || false;
    
    // Priority order for username:
    // 1. username field (for email/password users - this is what they entered during signup!)
    //    Auth0 structure: name = email, email = email, username = what they entered during signup
    // 2. name field (for Google OAuth users, but skip if it's just the email)
    // 3. nickname (if different from email)
    // 4. given_name + family_name (for Google OAuth users)
    // 5. Extract from email as fallback
    let username;
    
    // Check username field FIRST and use it directly (for email/password users)
    // This is the username they entered during signup - use it regardless of whether it equals email
    // The name field is just the email, so we ignore that and use username instead
    if (auth0User.username && auth0User.username.trim().length > 0) {
      username = auth0User.username.trim();
    }
    // Then check name field (for Google OAuth users, but skip if it equals email)
    else if (auth0User.name && auth0User.name !== email && auth0User.name.trim().length > 0) {
      username = auth0User.name.trim();
    }
    // Then check nickname (if different from email)
    else if (auth0User.nickname && auth0User.nickname !== email && auth0User.nickname.trim().length > 0) {
      username = auth0User.nickname.trim();
    }
    // Then given_name + family_name (for Google OAuth)
    else if (auth0User.given_name || auth0User.family_name) {
      username = [auth0User.given_name, auth0User.family_name].filter(Boolean).join(' ').trim();
      if (username.length === 0) {
        username = null; // Reset if empty after trimming
      }
    }
    
    // Fallback: extract from email if no username found
    if (!username && email) {
      // Extract username from email (e.g., "oblivionfolder@hotmail.com" -> "oblivionfolder")
      username = email.split('@')[0];
    }
    
    // Last resort fallback
    if (!username) {
      username = 'User';
    }

    // Debug logging in development to help troubleshoot
    if (process.env.NODE_ENV === 'development') {
      console.log('Auth0 user extraction:', {
        user_id: auth0User.user_id,
        email: email,
        username_field: auth0User.username,
        name_field: auth0User.name,
        nickname: auth0User.nickname,
        extracted_username: username
      });
    }

    return {
      user_id: auth0User.user_id,
      email: email,
      username: username,
      email_verified: emailVerified,
      picture: auth0User.picture || null
    };
  }
}

module.exports = new Auth0Service();
