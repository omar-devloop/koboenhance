/**
 * core/api/permissions.api.ts — sharing, removing access, and collaborator
 * permission operations against Kobo API v2.
 *
 * getPermissionAssignments additionally normalizes the API's URL-encoded
 * user/permission references into { username, permissionCode } pairs for
 * feature consumers; everything else is a thin KE.apiClient request wrapper.
 */
(function () {
  const KE = window.KoboEnhance;
  const { apiClient } = KE;

  function getPermissions(uid: UID, signal?: AbortSignal): Promise<unknown> {
    return apiClient.get(`/api/v2/assets/${uid}/permission-assignments/`, { signal });
  }

  /** Normalized collaborator list for an asset: [{ id?, username, permissionCode }]. */
  async function getPermissionAssignments(uid: UID, signal?: AbortSignal): Promise<PermissionAssignment[]> {
    const body = await getPermissions(uid, signal);
    const list: unknown[] = Array.isArray(body)
      ? (body as unknown[])
      : Array.isArray((body as KoboRecord).results)
        ? ((body as KoboRecord).results as unknown[])
        : [];
    const out: PermissionAssignment[] = [];
    for (const rowRaw of list) {
      if (!rowRaw || typeof rowRaw !== "object") continue;
      const row = rowRaw as KoboRecord;
      const usernameRef = typeof row.user === "string" ? row.user : "";
      const username = usernameRef ? String(usernameRef).split("/").filter(Boolean).pop() || "" : "";
      const permissionRef = typeof row.permission === "string" ? row.permission : "";
      const permissionCode = permissionRef ? String(permissionRef).split("/").filter(Boolean).pop() || "" : "";
      const urlRef = typeof row.url === "string" ? row.url : "";
      const id = urlRef ? String(urlRef).split("/").filter(Boolean).pop() || "" : "";
      if (username) out.push({ id, username, permissionCode });
    }
    return out;
  }

  function shareAsset(uid: UID, username: string, permissionCode: string, signal?: AbortSignal): Promise<unknown> {
    const base = apiClient.baseUrl();
    return apiClient.post(`/api/v2/assets/${uid}/permission-assignments/`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user: `${base}/api/v2/users/${username}/`,
        permission: `${base}/api/v2/permissions/${permissionCode}/`,
      }),
      signal,
    });
  }

  function removePermission(uid: UID, username: string, signal?: AbortSignal): Promise<unknown> {
    return apiClient.delete(`/api/v2/assets/${uid}/permission-assignments/bulk/`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: username,
      }),
      signal,
    });
  }

  /** Deletes one permission assignment by its id (URL suffix of the row). */
  function removePermissionAssignment(uid: UID, id: string, signal?: AbortSignal): Promise<unknown> {
    return apiClient.delete(`/api/v2/assets/${uid}/permission-assignments/${encodeURIComponent(id)}/`, {
      signal,
    });
  }

  function removeAsset(uid: UID, username: string, signal?: AbortSignal): Promise<unknown> {
    return apiClient.delete(`/api/v2/assets/${uid}/permission-assignments/bulk/`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
      signal,
    });
  }

  window.KoboEnhance.apiPermissions = {
    getPermissions,
    getPermissionAssignments,
    shareAsset,
    removePermission,
    removeAsset,
    removePermissionAssignment,
  };
})();