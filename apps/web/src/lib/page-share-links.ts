export function pageShareSlug(pathname: string) {
  try {
    return /^\/p\/([A-Za-z0-9_-]{43,104})$/.exec(decodeURI(pathname))?.[1];
  } catch {
    return undefined;
  }
}

export function usablePageShareUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      pageShareSlug(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
