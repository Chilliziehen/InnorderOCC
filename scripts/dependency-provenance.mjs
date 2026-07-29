function workspacePatternMatches(pattern, path) {
  const escaped = pattern
    .split("/")
    .map((segment) => segment === "*" ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("/");
  return new RegExp(`^${escaped}$`, "u").test(path);
}

function isRecognizedWorkspaceLink(lock, entry) {
  if (entry.link !== true || typeof entry.resolved !== "string") return false;
  const rootWorkspaces = lock.packages?.[""]?.workspaces;
  if (!Array.isArray(rootWorkspaces)) return false;
  if (!Object.hasOwn(lock.packages, entry.resolved)) return false;
  return rootWorkspaces.some((pattern) => (
    typeof pattern === "string" && workspacePatternMatches(pattern.replaceAll("\\", "/"), entry.resolved)
  ));
}

function isWorkspaceSourceRecord(lock, name) {
  if (name === "") return true;
  const rootWorkspaces = lock.packages?.[""]?.workspaces;
  return Array.isArray(rootWorkspaces) && rootWorkspaces.some((pattern) => (
    typeof pattern === "string" && workspacePatternMatches(pattern.replaceAll("\\", "/"), name)
  ));
}

function isOfficialRegistryArtifact(resolved) {
  let url;
  try {
    url = new URL(resolved);
  } catch {
    return false;
  }
  return url.protocol === "https:"
    && resolved.startsWith("https://registry.npmjs.org/")
    && url.hostname === "registry.npmjs.org"
    && url.port === ""
    && url.username === ""
    && url.password === ""
    && url.search === ""
    && url.hash === ""
    && url.pathname.endsWith(".tgz");
}

export function findNonRegistryArtifacts(lock) {
  const packages = lock?.packages ?? {};
  const rejected = [];
  for (const [name, entry] of Object.entries(packages)) {
    if (!entry || typeof entry !== "object") {
      rejected.push(`${name}: <invalid entry>`);
      continue;
    }
    if (!("resolved" in entry)) {
      if (!isWorkspaceSourceRecord(lock, name)) {
        rejected.push(`${name}: ${String(entry.version ?? "<missing resolved>")}`);
      }
      continue;
    }
    const resolved = entry.resolved;
    const accepted = isRecognizedWorkspaceLink(lock, entry)
      || (entry.link !== true && typeof resolved === "string" && isOfficialRegistryArtifact(resolved));
    if (!accepted) rejected.push(`${name}: ${String(resolved)}`);
  }
  return rejected;
}
