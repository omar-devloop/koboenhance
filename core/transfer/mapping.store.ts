/**
 * core/transfer/mapping.store.ts — "this source project was copied there, and
 * here is the destination UID", so a transfer never silently creates a second
 * copy of a project.
 *
 * WHY THIS EXISTS
 * Kobo's v2 API cannot copy a project, so every transfer CREATES a new asset on
 * the destination. That makes the operation non-idempotent: re-running a whole-
 * account transfer would duplicate every project.
 *
 * The store is NOT the decision, though. "Is this already there?" is answered by
 * the destination's own project list, read fresh on every run
 * (core/transfer/dest.api.ts, fetchProjectIndex): a remembered UID only counts
 * if the destination still has it. A mapping outlives the destination project
 * being deleted, and trusting it was how a dialog came to promise 2 projects /
 * 13 submissions for a run that would really copy 4 / 20.
 *
 * What the mapping adds on top of that list is exact identity: a source project
 * whose copy the user renamed is still recognised by UID, and the run can report
 * "already moved to <uid>" instead of matching by name.
 *
 * STORAGE
 * `chrome.storage.local`, one JSON blob under ke:transfer:mappings:
 *
 *   { "eu": { "<sourceUid>": { sourceUid, destUid, destName, at } } }
 *
 * The server id is the outer key, which is what makes the map safe to keep
 * when the user re-points the destination: Global and EU have different
 * accounts and different UID spaces, so entries never bleed across servers.
 * The destination URLs are deliberately NOT stored — they are re-derived from
 * the server id (see destination.store.ts) so a hand-edited entry cannot
 * redirect a transfer.
 *
 * Reads are synchronous off the shared cache; writes are queued so overlapping
 * read-modify-write cycles cannot drop each other's entry. See
 * core/transfer/state.backend.ts for why this is extension storage and not the
 * page's localStorage: a page-scoped copy survives an extension uninstall, which
 * would leave a reinstalled extension silently skipping already-copied projects.
 *
 * No secret is stored here. The API token is never persisted at all — it stays
 * in the destination store's memory for the lifetime of the page.
 */
(function () {
  const KE = window.KoboEnhance;

  const MAPPINGS_KEY = "ke:transfer:mappings";

  type MappingTable = Record<string, Record<string, TransferMapping>>;

  function toTable(value: unknown): MappingTable {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const table: MappingTable = {};
    for (const key of Object.keys(value as KoboRecord)) {
      const bucket = (value as KoboRecord)[key];
      if (bucket && typeof bucket === "object" && !Array.isArray(bucket)) {
        table[key] = bucket as Record<string, TransferMapping>;
      }
    }
    return table;
  }

  function readTable(): MappingTable {
    return toTable(KE.transferState.read(MAPPINGS_KEY));
  }

  function ready(): Promise<void> {
    return KE.transferState.ready([MAPPINGS_KEY]);
  }

  function isValidMapping(value: unknown): value is TransferMapping {
    if (!value || typeof value !== "object") return false;
    const m = value as Partial<TransferMapping>;
    return typeof m.sourceUid === "string" && m.sourceUid !== "" && typeof m.destUid === "string" && m.destUid !== "";
  }

  /** The remembered destination project for a source project, or null. */
  function get(server: TransferServerId, sourceUid: UID): TransferMapping | null {
    const bucket = readTable()[server];
    if (!bucket) return null;
    const found = bucket[sourceUid];
    return isValidMapping(found) ? found : null;
  }

  /**
   * Records a completed copy. Returns false only when the write could not be
   * persisted, which the caller reports as a warning rather than a failure —
   * the copy itself already happened on the destination.
   */
  async function set(server: TransferServerId, mapping: TransferMapping): Promise<boolean> {
    if (!isValidMapping(mapping)) return false;
    const table = readTable();
    if (!table[server] || typeof table[server] !== "object") table[server] = {};
    table[server][mapping.sourceUid] = {
      sourceUid: mapping.sourceUid,
      destUid: mapping.destUid,
      destName: typeof mapping.destName === "string" ? mapping.destName : "",
      at: typeof mapping.at === "number" ? mapping.at : Date.now(),
    };
    return KE.transferState.write(MAPPINGS_KEY, table);
  }

  /** Forgets one project, so the user can copy it again on purpose. */
  async function remove(server: TransferServerId, sourceUid: UID): Promise<void> {
    const table = readTable();
    if (table[server]) {
      delete table[server][sourceUid];
      await KE.transferState.write(MAPPINGS_KEY, table);
    }
  }

  /** All mappings for one server, newest first. Used by the report. */
  function list(server: TransferServerId): TransferMapping[] {
    const bucket = readTable()[server];
    if (!bucket) return [];
    return Object.keys(bucket)
      .map((key) => bucket[key])
      .filter(isValidMapping)
      .sort((a, b) => b.at - a.at);
  }

  function count(server: TransferServerId): number {
    return list(server).length;
  }

  /** Clears one server's mappings (the other server is untouched). */
  async function clear(server: TransferServerId): Promise<void> {
    const table = readTable();
    delete table[server];
    await KE.transferState.write(MAPPINGS_KEY, table);
  }

  window.KoboEnhance.transferMapping = {
    ready,
    get,
    set,
    remove,
    list,
    count,
    clear,
  };
})();
