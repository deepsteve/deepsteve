/**
 * What we will believe from a release document we did not write.
 *
 * `checkForUpdates()` fetches the GitHub releases API and the answer flows three places that
 * all matter: into a URL the updater downloads and runs under `bash`, into a WebSocket
 * broadcast, and into the DOM. So the response is untrusted input, and the trust boundary is
 * here rather than at each of those three sinks.
 *
 * The rule is narrow on purpose: a release is a tag we published, in the shape we publish it,
 * and its install.sh lives where our own release.sh puts it. Nothing in the response body
 * chooses a host, a path, or a scheme — we derive the download URL from the tag instead of
 * reading `browser_download_url`, because a field that names an arbitrary origin is a field
 * that can name someone else's.
 *
 * Lives at the repo root, not inside server.js, so a plain `node --test` can require it
 * without booting a daemon — same reason as git-root.js and mod-kind.js. Root *.js files are
 * copied by restart.sh and release.sh by glob and covered by package.json's `files`, so it
 * ships with no deploy-script change.
 */

const REPO = 'deepsteve/deepsteve';

// Semver with an optional leading `v` and an optional prerelease suffix — every tag this repo
// has ever cut. Deliberately excludes `/`, `.` runs, `?`, `#`, whitespace and anything that
// could carry markup, because a tag that passes here is later spliced into a URL path and
// rendered in the settings modal and the auto-apply toast.
const RELEASE_TAG = /^v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z][0-9A-Za-z.]*)?$/;
const MAX_TAG_LENGTH = 64;

function isValidReleaseTag(tag) {
  return typeof tag === 'string' && tag.length <= MAX_TAG_LENGTH && RELEASE_TAG.test(tag);
}

/**
 * Where this release's install.sh must be, given its tag. Constructed, never read off the
 * response: applyCurlReinstall() chmods the download 0755 and spawns bash on it, so the set of
 * origins that can reach that call has to be a constant in our source.
 *
 * encodeURIComponent is redundant against RELEASE_TAG as written — it is here so the function
 * stays safe on its own terms if that pattern is ever widened.
 *
 * @returns {string|null} null when the tag is not one of ours
 */
function installShUrl(tag) {
  if (!isValidReleaseTag(tag)) return null;
  return `https://github.com/${REPO}/releases/download/${encodeURIComponent(tag)}/install.sh`;
}

/**
 * The "View on GitHub" link. Rendered as an href, so the scheme is the whole point: escaping
 * the value protects the attribute but says nothing about `javascript:`. Host is pinned too,
 * since the only link we ever want to offer here is the release's own page.
 *
 * @returns {string|null} null when the URL is missing, unparseable, or not a GitHub https URL
 */
function safeReleaseUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  // `host` and not `hostname`: a port that is not GitHub's is not GitHub. URL parsing is also
  // what defeats the userinfo trick (`https://github.com@elsewhere/`) and resolves dot
  // segments, so there is no separate `..` check to write.
  if (u.protocol !== 'https:' || u.host !== 'github.com') return null;
  return u.href;
}

module.exports = { isValidReleaseTag, installShUrl, safeReleaseUrl, RELEASE_TAG, REPO };
