"use strict";
/**
 * core/api/assets.api.ts — project/asset operations against Kobo API v2.
 *
 * Single-asset fetch, lifecycle (archive/unarchive via the deployment
 * endpoint), rename, and settings-metadata updates (country, sector,
 * description, tags). Each operation is a thin KE.apiClient call with its own
 * URL, method, and payload — no business logic here. Endpoints and payloads
 * are identical to the pre-centralization API layer.
 */
(function () {
    const KE = window.KoboEnhance;
    const { apiClient } = KE;
    function fetchAsset(uid, signal) {
        return apiClient.get(`/api/v2/assets/${uid}/`, { signal });
    }
    /** Archives (active=false) or re-activates (active=true) a deployed form. */
    function setAssetActive(uid, active, signal) {
        return apiClient.patch(`/api/v2/assets/${uid}/deployment/`, {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ active }),
            signal,
        });
    }
    /** Renames an asset (project) via PATCH on the asset itself. */
    function renameAsset(uid, newName, signal) {
        return apiClient.patch(`/api/v2/assets/${uid}/`, {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: newName }),
            signal,
        });
    }
    /** Replaces the asset's full country list (stored in settings.country). */
    function updateAssetCountry(uid, countryObjects, signal) {
        return apiClient.patch(`/api/v2/assets/${uid}/`, {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ settings: { country: countryObjects } }),
            signal,
        });
    }
    /** Sets the asset's single sector value (stored in settings.sector). */
    function updateAssetSector(uid, sectorObject, signal) {
        return apiClient.patch(`/api/v2/assets/${uid}/`, {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ settings: { sector: sectorObject } }),
            signal,
        });
    }
    /** Sets the asset's description text (stored in settings.description). */
    function updateAssetDescription(uid, description, signal) {
        return apiClient.patch(`/api/v2/assets/${uid}/`, {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ settings: { description } }),
            signal,
        });
    }
    /** Replaces the asset's full extra_metadata object, so callers merge the
     *  freshly-read object (e.g. Object.assign({}, current, { notes })) — any
     *  other keys already stored there (tags, etc.) are preserved. */
    function updateAssetExtraMetadata(uid, extraMetadata, signal) {
        return apiClient.patch(`/api/v2/assets/${uid}/`, {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ settings: { extra_metadata: extraMetadata } }),
            signal,
        });
    }
    /** Sets the asset's tags by PATCHing the full extra_metadata object, so any
     *  other keys already stored there are preserved. */
    function updateAssetTags(uid, extraMetadata, signal) {
        return updateAssetExtraMetadata(uid, extraMetadata, signal);
    }
    window.KoboEnhance.apiAssets = {
        fetchAsset,
        setAssetActive,
        renameAsset,
        updateAssetCountry,
        updateAssetSector,
        updateAssetDescription,
        updateAssetExtraMetadata,
        updateAssetTags,
    };
})();
