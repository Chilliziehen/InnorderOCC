export function isAllowedNavigation(
  rendererUrl: string,
  requestedUrl: string,
): boolean {
  try {
    return new URL(requestedUrl).href === new URL(rendererUrl).href;
  } catch {
    return false;
  }
}
