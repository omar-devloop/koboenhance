"use strict";
/**
 * core/api/users.api.ts — read/write access to Kobo user records.
 *
 * lookupUser doubles as a validity probe: collabactions resolve to a 404 when
 * the username does not exist, which callers surface as "User not found".
 */
(function () {
    const KE = window.KoboEnhance;
    const { apiClient } = KE;
    function lookupUser(username, signal) {
        return apiClient.get(`/api/v2/users/${encodeURIComponent(username)}/`, { signal });
    }
    function getCurrentUser(signal) {
        return apiClient.get(`/api/v2/users/me/`, { signal });
    }
    window.KoboEnhance.apiUsers = {
        lookupUser,
        getCurrentUser,
    };
})();
