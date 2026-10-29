/**
 * core/api/environment.api.ts — server-level metadata for the current Kobo
 * instance, used to gate someone else's deployment (soft-global actions).
 */
(function () {
  const KE = window.KoboEnhance;
  const { apiClient } = KE;

  function fetchEnvironment(signal?: AbortSignal): Promise<EnvironmentResponse> {
    return apiClient.get<EnvironmentResponse>(`/api/v2/environment/`, { signal });
  }

  window.KoboEnhance.apiEnvironment = { fetchEnvironment };
})();