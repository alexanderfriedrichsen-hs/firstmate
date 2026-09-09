import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { flockSync } from "fs-ext";
export function homePath(
  value = process.env.FM_HOME,
  options: {
    allowTransferred?: boolean;
    allowReleasedRecovery?: boolean;
    rollbackReportId?: string;
  } = {},
): string {
  if (!value || !path.isAbsolute(value))
    throw new Error("Set FM_HOME to an explicit absolute isolated home.");
  const resolved = path.resolve(value);
  const livePath = path.join(os.homedir(), ".firstmate");
  const live = fs.existsSync(livePath) ? fs.realpathSync(livePath) : livePath;
  // Resolve existing ancestors to reject symlink aliases of the live home.
  let ancestor = resolved;
  const tails: string[] = [];
  while (!fs.existsSync(ancestor)) {
    tails.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  const canonical = path.join(fs.realpathSync(ancestor), ...tails);
  if (canonical === live || canonical.startsWith(live + path.sep)) {
    let transferred = false;
    if (options.allowTransferred && canonical === live) {
      try {
        const receipt = JSON.parse(
          fs.readFileSync(
            path.join(canonical, "app", "cutover-receipt.json"),
            "utf8",
          ),
        );
        const marker = JSON.parse(
          fs.readFileSync(path.join(canonical, "app", "control-mode"), "utf8"),
        );
        transferred =
          receipt.schema === "firstmate.ownership.v1" &&
          receipt.complete === true &&
          receipt.source === canonical &&
          marker.mode === "app" &&
          receipt.reportId === marker.reportId &&
          fs.existsSync(path.join(canonical, "app", "state.sqlite"));
      } catch {}
    }
    if (
      !transferred &&
      options.allowTransferred &&
      options.allowReleasedRecovery &&
      canonical === live
    ) {
      try {
        const receipt = JSON.parse(
          fs.readFileSync(
            path.join(canonical, "app", "rollback-receipt.json"),
            "utf8",
          ),
        );
        const transfer = JSON.parse(
          fs.readFileSync(
            path.join(canonical, "app", "cutover-receipt.json"),
            "utf8",
          ),
        );
        transferred =
          receipt.schema === "firstmate.rollback.v1" &&
          receipt.ownershipTransferred === true &&
          (!options.rollbackReportId ||
            options.rollbackReportId === receipt.reportId) &&
          transfer.schema === "firstmate.ownership.v1" &&
          transfer.source === canonical &&
          fs.existsSync(path.join(canonical, "app", "state.sqlite"));
      } catch {}
    }
    if (!transferred)
      throw new Error(
        "Development runtime refuses the canonical live Firstmate home. A completed transfer and --transferred-home are required.",
      );
  }
  fs.mkdirSync(canonical, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(canonical, "app"), { recursive: true, mode: 0o700 });
  return canonical;
}
export function processIdentity(pid = process.pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}
export function alive(pid: number, identity: string) {
  return !!identity && processIdentity(pid) === identity;
}
export function ownHome(home: string) {
  const file = path.join(home, "app", "owner.lock");
  if (fs.lstatSync(path.join(home, "app")).isSymbolicLink())
    throw new Error("Ownership directory cannot be a symlink");
  const fd = fs.openSync(
    file,
    fs.constants.O_CREAT |
      fs.constants.O_APPEND |
      fs.constants.O_RDWR |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    flockSync(fd, "exnb");
    fs.fchmodSync(fd, 0o600);
  } catch {
    fs.closeSync(fd);
    throw new Error("Another runtime owns this home.");
  }
  return () => {
    flockSync(fd, "un");
    fs.closeSync(fd);
  };
}
export function atomic(file: string, data: string | Buffer) {
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  const fd = fs.openSync(tmp, "r");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
  const dir = fs.openSync(path.dirname(file), "r");
  fs.fsyncSync(dir);
  fs.closeSync(dir);
}
