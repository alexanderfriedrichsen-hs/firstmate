import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { atomic, ownHome } from "./home.ts";
const hash = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
function regular(root: string, relative: string) {
  if (
    path.isAbsolute(relative) ||
    relative.split(path.sep).some((part) => part === "..")
  )
    throw new Error("Invalid relative path");
  let cursor = root;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink())
        throw new Error("Refusing symlink: " + cursor);
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!fs.existsSync(cursor)) return null;
  if (!fs.statSync(cursor).isFile())
    throw new Error("Expected regular file: " + cursor);
  return fs.readFileSync(cursor);
}
function quiescence(root: string) {
  const problems: string[] = [];
  for (const relative of [
    "state/.lock",
    "state/.watch.lock/pid",
    "state/.afk-launch.lock/pid",
  ]) {
    let content: Buffer | null;
    try {
      let inspected = relative;
      if (relative === "state/.watch.lock/pid") {
        const lock = path.join(root, "state/.watch.lock");
        let stat: fs.Stats | undefined;
        try {
          stat = fs.lstatSync(lock);
        } catch (error: any) {
          if (error.code !== "ENOENT") throw error;
        }
        if (stat?.isSymbolicLink()) {
          const owner = fs.realpathSync(lock);
          if (
            path.dirname(owner) !== path.join(root, "state") ||
            !/^\.watch\.lock\.owner\.[A-Za-z0-9_-]+$/.test(path.basename(owner))
          )
            throw new Error(
              "Watcher owner link escapes its expected state directory",
            );
          inspected = path.relative(root, path.join(owner, "pid"));
        }
      }
      content = regular(root, inspected);
      if (
        !content &&
        relative.endsWith("/pid") &&
        fs.existsSync(path.dirname(path.join(root, relative)))
      )
        throw new Error("Legacy owner directory has no PID");
    } catch (error) {
      problems.push(
        "Cannot inspect legacy lock " + relative + ": " + String(error),
      );
      continue;
    }
    if (!content) continue;
    const pid = Number(content.toString().trim());
    if (!Number.isInteger(pid) || pid < 2) {
      problems.push("Unknown legacy owner: " + relative);
      continue;
    }
    try {
      process.kill(pid, 0);
      problems.push("Quiesce legacy owner " + pid + " at " + relative);
    } catch (error: any) {
      if (error.code !== "ESRCH")
        problems.push("Cannot inspect legacy owner " + pid);
    }
  }
  return problems;
}
export function prepareFenceInstall(
  targetHome: string,
  repositoryRoot: string,
) {
  const target = fs.realpathSync(targetHome),
    repository = fs.realpathSync(repositoryRoot);
  if (
    target === repository ||
    target.startsWith(repository + path.sep) ||
    repository.startsWith(target + path.sep)
  )
    throw new Error("Fence target must differ from the source checkout");
  let gitTracked = false;
  try {
    const gitRoot = execFileSync(
      "git",
      ["-C", target, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    if (fs.realpathSync(gitRoot) !== target)
      throw new Error("Target is nested inside another checkout");
    gitTracked = true;
  } catch (error: any) {
    if (!error.status) throw error;
  }
  const blockers = quiescence(target);
  const files = ["", "backends"]
    .flatMap((sub) =>
      fs
        .readdirSync(path.join(repository, "bin", sub))
        .filter((name) => name.endsWith(".sh"))
        .map((name) => path.join("bin", sub, name)),
    )
    .sort()
    .map((relative) => {
      const source = regular(repository, relative)!;
      const current = regular(target, relative);
      if (gitTracked) {
        const dirty = execFileSync(
          "git",
          [
            "-C",
            target,
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--",
            relative,
          ],
          {
            encoding: "utf8",
            env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
          },
        );
        if (dirty.trim())
          blockers.push("Target has local or staged edits: " + relative);
      }
      return {
        relative,
        beforeHash: current ? hash(current) : null,
        beforeMode: current
          ? fs.statSync(path.join(target, relative)).mode & 0o777
          : null,
        afterHash: hash(source),
        mode: fs.statSync(path.join(repository, relative)).mode & 0o777,
      };
    });
  const body = {
    schema: "firstmate.fence-install.v1",
    id: randomUUID(),
    target,
    repository,
    files,
    targetVerification: gitTracked
      ? "clean Git working tree"
      : "operational home: approve exact existing hashes; no Git baseline available",
    blockers,
    ready: blockers.length === 0,
  };
  return { ...body, fingerprint: hash(JSON.stringify(body)) };
}
export type FenceInstallReport = ReturnType<typeof prepareFenceInstall>;
/** Rerun with the same report after interruption. Any unexpected file edit blocks recovery. */
export function executeFenceInstall(
  report: FenceInstallReport,
  approvalId: string,
) {
  const { fingerprint, ...body } = report;
  if (
    approvalId !== report.id ||
    !report.ready ||
    hash(JSON.stringify(body)) !== fingerprint
  )
    throw new Error("Approve the exact ready fence installation report");
  if (
    fs.realpathSync(report.target) !== report.target ||
    fs.realpathSync(report.repository) !== report.repository
  )
    throw new Error("Installation roots changed");
  if (
    !/^[a-f0-9-]{36}$/.test(report.id) ||
    report.files.some(
      (file) => !/^bin\/(?:backends\/)?[^/]+\.sh$/.test(file.relative),
    )
  )
    throw new Error("Invalid report paths");
  regular(report.target, "app/owner.lock");
  fs.mkdirSync(path.join(report.target, "app"), {
    recursive: true,
    mode: 0o700,
  });
  const release = ownHome(report.target);
  try {
    const blockers = quiescence(report.target);
    if (blockers.length) throw new Error(blockers.join("; "));
    const location = path.join(
      report.target,
      "app",
      "fence-installs",
      report.id,
    );
    regular(
      report.target,
      path.relative(report.target, path.join(location, "report.json")),
    );
    const manifest = path.join(location, "report.json");
    const resumed = fs.existsSync(manifest);
    if (resumed && fs.readFileSync(manifest, "utf8") !== JSON.stringify(report))
      throw new Error("Recovery report differs");
    if (!resumed) {
      const fresh = prepareFenceInstall(report.target, report.repository);
      if (
        !fresh.ready ||
        JSON.stringify(fresh.files) !== JSON.stringify(report.files)
      )
        throw new Error("Installation changed; prepare a fresh report");
    }
    const reviewedSources = new Map<string, Buffer>();
    for (const file of report.files) {
      const sourceBytes = regular(report.repository, file.relative)!;
      reviewedSources.set(file.relative, sourceBytes);
      if (hash(sourceBytes) !== file.afterHash)
        throw new Error("Source changed: " + file.relative);
      const content = regular(report.target, file.relative),
        current = content ? hash(content) : null;
      const mode = content
        ? fs.statSync(path.join(report.target, file.relative)).mode & 0o777
        : null;
      if (
        mode !== file.beforeMode &&
        !(
          resumed &&
          (mode === file.mode || (mode === 0o600 && current === file.afterHash))
        )
      )
        throw new Error("Target mode changed: " + file.relative);
      if (
        current !== file.beforeHash &&
        !(resumed && current === file.afterHash)
      )
        throw new Error("Target changed: " + file.relative);
    }
    if (!resumed) {
      fs.mkdirSync(path.join(location, "originals"), {
        recursive: true,
        mode: 0o700,
      });
      for (const file of report.files) {
        const content = regular(report.target, file.relative);
        if (!content) continue;
        const backup = path.join(location, "originals", file.relative);
        regular(report.target, path.relative(report.target, backup));
        fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
        atomic(backup, content);
        fs.chmodSync(
          backup,
          fs.statSync(path.join(report.target, file.relative)).mode & 0o777,
        );
      }
      atomic(manifest, JSON.stringify(report));
    }
    // The durable manifest and originals precede every replacement. Recovery accepts
    // only the reviewed old or new bytes, never an intervening operator edit.
    for (const file of report.files) {
      const destination = path.join(report.target, file.relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      atomic(destination, reviewedSources.get(file.relative)!);
      fs.chmodSync(destination, file.mode);
    }
    const receipt = {
      schema: "firstmate.fence-install-receipt.v1",
      reportId: report.id,
      target: report.target,
      backup: location,
      complete: true,
      files: report.files.length,
    };
    atomic(path.join(location, "receipt.json"), JSON.stringify(receipt));
    return receipt;
  } finally {
    release();
  }
}
