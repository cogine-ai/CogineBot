export function pageShareSlug(pathname: string) {
  try {
    return /^\/p\/([A-Za-z0-9_-]{43,104})$/.exec(decodeURI(pathname))?.[1];
  } catch {
    return undefined;
  }
}
