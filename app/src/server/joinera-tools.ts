import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function joineraTool(
  kind: "draft" | "validation",
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string {
  const variable =
    kind === "draft"
      ? "FIRSTMATE_JOINERA_ADAPTER"
      : "FIRSTMATE_JOINERA_VALIDATION_LAYER";
  const name =
    kind === "draft" ? "joinera-draft-pr-adapter" : "joinera-validation-layer";
  const executable = env[variable] || path.join(home, ".local", "bin", name);
  if (!path.isAbsolute(executable))
    throw new Error(`${variable} must be an absolute executable path`);
  try {
    if (!fs.statSync(executable).isFile()) throw new Error("Not a file");
    fs.accessSync(executable, fs.constants.X_OK);
  } catch {
    throw new Error(
      `Install ${name} at ${executable}, or set ${variable} to its absolute executable path`,
    );
  }
  return executable;
}
