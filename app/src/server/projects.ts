import fs from "node:fs";
import path from "node:path";
import { git } from "./revisions.ts";
import type { Store } from "./store.ts";
import type { Ticket } from "../contracts.ts";

export type Project = {
  id: string;
  source: string;
  remote: string;
  profile: string;
  requiredChecks: string[];
  draftPrEnabled?: boolean;
  mode?: string;
};
export function repositoryIdentity(value: string) {
  return value
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git\/?$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}
/** Only the configured source and registered clones in this operational home are dispatchable. */
export function projects(store: Store): Project[] {
  const configured = store.setting("project");
  const result: Project[] = configured?.source
    ? [
        {
          ...configured,
          id: "default",
          requiredChecks: configured.requiredChecks ?? [],
        },
      ]
    : [];
  const registry = path.join(store.home, "data", "projects.md");
  if (!fs.existsSync(registry)) return result;
  if (
    fs.realpathSync(path.dirname(registry)) !== path.dirname(registry) ||
    fs.lstatSync(registry).isSymbolicLink() ||
    !fs.statSync(registry).isFile() ||
    fs.statSync(registry).size > 131072
  )
    throw new Error(
      "Project registry must be a bounded regular file in this home",
    );
  const parent = path.join(store.home, "projects");
  if (!fs.existsSync(parent)) return result;
  if (fs.realpathSync(parent) !== parent)
    throw new Error("Project directory must belong to this home");
  for (const match of fs
    .readFileSync(registry, "utf8")
    .matchAll(/^\s*-\s+([a-zA-Z0-9][a-zA-Z0-9._-]*)\s+\[([^\]\r\n]+)\]/gm)) {
    const [, id, mode] = match;
    if (id === "default" || result.some((p) => p.id === id)) continue;
    const source = path.join(parent, id);
    if (!fs.existsSync(source)) continue;
    if (fs.realpathSync(source) !== source) continue;
    try {
      if (git(source, ["rev-parse", "--show-toplevel"]) !== source) continue;
      const remote = git(source, ["remote", "get-url", "origin"]);
      result.push({
        id,
        source,
        remote,
        mode,
        profile: "code_only",
        requiredChecks: [],
      });
    } catch {
      /* An unavailable clone is not an allocatable project. */
    }
  }
  return result;
}
function matchesHint(project: Project, hint: string) {
  const h = repositoryIdentity(hint);
  return (
    h === project.id ||
    h === repositoryIdentity(project.remote) ||
    h === path.basename(repositoryIdentity(project.remote)) ||
    h === project.source.toLowerCase() ||
    h === path.basename(project.source).toLowerCase()
  );
}
export function assertProjectScope(
  project: Project,
  t: Pick<Ticket, "brief" | "links">,
) {
  const hints = [...t.brief.matchAll(/\((?:repo|project):\s*([^)]*)\)/gi)].map(
    (m) => m[1],
  );
  hints.push(
    ...t.links
      .filter((l) => l.kind === "github_pr")
      .map((l) => new URL(l.url).pathname.split("/").slice(1, 3).join("/")),
  );
  if (hints.some((h) => !matchesHint(project, h)))
    throw new Error(
      "Explicit project contradicts the ticket repository or linked PR; correct projectId or repository association before dispatch",
    );
}
export function ticketProject(
  store: Store,
  t: Pick<Ticket, "projectId" | "brief" | "links">,
): Project {
  const catalog = projects(store);
  if (t.projectId) {
    const chosen = catalog.find((p) => p.id === t.projectId);
    if (!chosen)
      throw new Error(
        `Unknown or unavailable project ${t.projectId}; read projects and select an available projectId`,
      );
    assertProjectScope(chosen, t);
    return chosen;
  }
  const hints = [...t.brief.matchAll(/\((?:repo|project):\s*([^)]*)\)/gi)].map(
    (m) => m[1].trim().toLowerCase(),
  );
  const urls = t.links.filter((l) => l.kind === "github_pr").map((l) => l.url);
  if (!urls.length)
    urls.push(
      ...[
        ...t.brief.matchAll(
          /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/g,
        ),
      ].map((m) => m[0]),
    );
  hints.push(
    ...urls.map((url) =>
      new URL(url).pathname.split("/").slice(1, 3).join("/").toLowerCase(),
    ),
  );
  if (hints.length) {
    const matches = catalog.filter((p) =>
      hints.every((h) => matchesHint(p, h)),
    );
    if (matches.length === 1) return matches[0];
    throw new Error(
      "Ticket repository is unavailable or ambiguous; read projects and set an explicit projectId before dispatch",
    );
  }
  if (catalog.length === 1) return catalog[0];
  if (!catalog.length) throw new Error("Configure a project source first");
  throw new Error(
    "Multiple projects are available; set ticket.projectId before dispatch",
  );
}
