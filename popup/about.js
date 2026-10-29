/**
 * popup/about.js — fills the About popup.
 *
 * WHY IT IS A FILE
 * Manifest V3 extension pages run under the default CSP `script-src 'self'`,
 * which refuses inline <script>. The version used to be written by an inline
 * script, so it never ran and the badge stayed as "…" on every install.
 *
 * The version and description come from the manifest itself, so the popup can
 * never disagree with what is actually installed. The diagnostics card reads
 * the same chrome.storage.local key that core/errors/guard.js writes.
 */
(function () {
  var STORAGE_KEY = "ke:diagnostics";

  var manifest = chrome.runtime.getManifest();
  var version = document.getElementById("version");
  var description = document.getElementById("description");
  if (version) version.textContent = "v" + manifest.version;
  if (description) description.textContent = (manifest && manifest.description) || "";

  var statusEl = document.getElementById("diag-status");
  var copyBtn = document.getElementById("diag-copy");
  var clearBtn = document.getElementById("diag-clear");
  if (!statusEl || !copyBtn || !clearBtn) return;

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function entryCount(data) {
    if (!data || !Array.isArray(data.entries)) return 0;
    return data.entries.length;
  }

  function render(data) {
    var count = entryCount(data);
    if (!count) {
      setStatus("No errors recorded.");
      copyBtn.disabled = true;
      clearBtn.disabled = true;
      return;
    }
    var last = data.entries[0] && data.entries[0].time ? new Date(data.entries[0].time) : null;
    var suffix = last && !isNaN(last.getTime()) ? " · last " + last.toLocaleString() : "";
    setStatus(count + (count === 1 ? " error recorded" : " errors recorded") + suffix);
    copyBtn.disabled = false;
    clearBtn.disabled = false;
  }

  function read() {
    chrome.storage.local
      .get(STORAGE_KEY)
      .then(function (data) {
        render(data ? data[STORAGE_KEY] : null);
      })
      .catch(function () {
        setStatus("Diagnostics unavailable.");
        copyBtn.disabled = true;
        clearBtn.disabled = true;
      });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () {
          return true;
        },
        function () {
          return copyFallback(text);
        }
      );
    }
    return Promise.resolve(copyFallback(text));
  }

  function copyFallback(text) {
    try {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "true");
      area.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  copyBtn.addEventListener("click", function () {
    chrome.storage.local
      .get(STORAGE_KEY)
      .then(function (data) {
        var payload = (data && data[STORAGE_KEY]) || { entries: [] };
        return copyText(JSON.stringify(payload, null, 2));
      })
      .then(function (ok) {
        setStatus(ok ? "Copied. Paste it into your support message." : "Could not copy the diagnostics.");
        window.setTimeout(read, 2500);
      })
      .catch(function () {
        setStatus("Diagnostics unavailable.");
      });
  });

  clearBtn.addEventListener("click", function () {
    chrome.storage.local
      .remove(STORAGE_KEY)
      .then(read)
      .catch(function () {
        setStatus("Diagnostics unavailable.");
      });
  });

  read();
})();
