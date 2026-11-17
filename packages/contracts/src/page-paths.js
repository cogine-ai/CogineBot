/** Shared public renderer asset served without account credentials. */
export const PAGE_RUNTIME_PATH = "/api/v1/assets/page-runtime.js";
export const SHARED_PAGE_PATH_PREFIX = "/api/v1/pages/shared/";

/** Classify the sensitive API namespace for credentials and logs, never for authorization.
 * @param {string} pathname
 */
export function isPageShareApiPath(pathname) {
  return isSensitiveNamespace(pathname, SHARED_PAGE_PATH_PREFIX.slice(0, -1));
}

/** Also recognize aliases a server or proxy could normalize into the document route.
 * @param {string} pathname
 */
export function isSensitivePageShareDocumentPath(pathname) {
  return isSensitiveNamespace(pathname, "/p");
}

/** @param {string} pathname
 * @param {string} prefix
 */
function isSensitiveNamespace(pathname, prefix) {
  // Decode individual escapes so a malformed suffix cannot hide an encoded namespace.
  const normalized = pathname
    .replace(/%([0-9a-f]{2})/gi, (_, byte) => String.fromCharCode(Number.parseInt(byte, 16)))
    .toLowerCase()
    .replace(/[\\/]+/g, "/");
  const matches = (path) => path === prefix || path.startsWith(`${prefix}/`);
  if (matches(normalized)) return true;
  return (
    normalized.startsWith("/") &&
    /\/\.{1,2}(?:\/|$)/.test(normalized) &&
    matches(new URL(normalized, "http://localhost").pathname)
  );
}

/** @param {string} pathname */
export function isPageShareDocumentPath(pathname) {
  // %70 is the encoded form of the route segment. Encoded separators are not routes.
  return /^\/(?:p|%70)(?:\/|$)/.test(pathname);
}
