import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadStandingOrders,
  standingOrderLimits,
} from "../src/server/standing-orders.ts";

function fixture(t: { after(fn: () => void): void }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fm-orders-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, "data"));
  fs.mkdirSync(path.join(home, "config"));
  return home;
}

test("standing orders preserve complete home preferences with deterministic provenance and missing markers", (t) => {
  const home = fixture(t);
  const preference =
    "# Captain\nUse Codex for implementation; Claude for review.\n";
  fs.writeFileSync(path.join(home, "data/captain.md"), preference);
  fs.writeFileSync(path.join(home, "data/projects.md"), "");
  fs.writeFileSync(
    path.join(home, "config/crew-dispatch.json"),
    '{"rules":[]}',
  );
  const result = loadStandingOrders(home, "supervisor");
  assert.deepEqual(result, loadStandingOrders(home, "supervisor"));
  assert.equal(
    result.sources.find((s) => s.path.endsWith("captain.md"))?.content,
    preference,
  );
  assert.ok(
    result.sources.every(
      (s) => path.isAbsolute(s.path) && s.reason.includes("supervisor"),
    ),
  );
  assert.match(result.text, /present, empty/);
  assert.ok(
    result.warnings.some(
      (w) => w.path.endsWith("secondmates.md") && w.reason.startsWith("ABSENT"),
    ),
  );
  assert.match(result.text, /Never start or rearm legacy watcher/);
  assert.match(result.text, /independent validation and review/);
});

test("workers receive no supervisor context, and raw backlog or credentials never enter the supervisor digest", (t) => {
  const home = fixture(t);
  for (const name of ["captain.md", "backlog.md"])
    fs.writeFileSync(
      path.join(home, "data", name),
      name === "backlog.md" ? "HUMAN_ONLY_SECRET" : "PRIVATE_PREFERENCE",
    );
  fs.writeFileSync(path.join(home, ".env"), "TOKEN_SECRET");
  assert.deepEqual(loadStandingOrders(home, "worker"), {
    text: "",
    sources: [],
    warnings: [],
  });
  assert.deepEqual(loadStandingOrders("/unreadable/other/home", "reviewer"), {
    text: "",
    sources: [],
    warnings: [],
  });
  const result = loadStandingOrders(home, "supervisor");
  assert.match(result.text, /PRIVATE_PREFERENCE/);
  assert.doesNotMatch(result.text, /HUMAN_ONLY_SECRET|TOKEN_SECRET/);
});

test("standing order loader rejects linked files and directories across homes", (t) => {
  const home = fixture(t);
  const other = fixture(t);
  fs.writeFileSync(path.join(other, "data/captain.md"), "OTHER_HOME_PRIVATE");
  fs.symlinkSync(
    path.join(other, "data/captain.md"),
    path.join(home, "data/captain.md"),
  );
  fs.rmdirSync(path.join(home, "config"));
  fs.symlinkSync(path.join(other, "data"), path.join(home, "config"));
  const result = loadStandingOrders(home, "supervisor");
  assert.doesNotMatch(result.text, /OTHER_HOME_PRIVATE/);
  assert.ok(
    result.warnings.some(
      (w) => w.path.endsWith("captain.md") && w.reason.startsWith("REJECTED"),
    ),
  );
  assert.ok(
    result.warnings.some(
      (w) => w.path.endsWith("crew-harness") && w.reason.startsWith("REJECTED"),
    ),
  );
});

test("oversized and non-file sources are explicit omissions, never partial provenance", (t) => {
  const home = fixture(t);
  fs.writeFileSync(
    path.join(home, "data/captain.md"),
    "X".repeat(standingOrderLimits.fileBytes + 1),
  );
  fs.mkdirSync(path.join(home, "data/projects.md"));
  const result = loadStandingOrders(home, "supervisor");
  assert.equal(result.sources.length, 0);
  assert.ok(
    result.warnings.some(
      (w) => w.path.endsWith("captain.md") && w.reason.startsWith("OMITTED"),
    ),
  );
  assert.ok(
    result.warnings.some(
      (w) => w.path.endsWith("projects.md") && w.reason.startsWith("REJECTED"),
    ),
  );
  assert.doesNotMatch(result.text, /XXXXX/);
});

test("session byte budget loads whole files in fixed order and reports the remaining omissions", (t) => {
  const home = fixture(t);
  for (const name of ["projects", "secondmates", "captain", "learnings"])
    fs.writeFileSync(
      path.join(home, "data", name + ".md"),
      "A".repeat(standingOrderLimits.fileBytes),
    );
  fs.writeFileSync(path.join(home, "config/crew-dispatch.json"), "{}");
  const result = loadStandingOrders(home, "supervisor");
  assert.equal(result.sources.length, 4);
  assert.ok(
    result.warnings.some(
      (w) =>
        w.path.endsWith("crew-dispatch.json") &&
        w.reason.includes("session limit"),
    ),
  );
});

test("invalid UTF-8 and unavailable homes report warnings without claiming a source was loaded", (t) => {
  const home = fixture(t);
  fs.writeFileSync(path.join(home, "data/captain.md"), Buffer.from([0xff]));
  assert.equal(loadStandingOrders(home, "supervisor").sources.length, 0);
  const result = loadStandingOrders(path.join(home, "absent"), "supervisor");
  assert.equal(result.sources.length, 0);
  assert.match(result.warnings[0].reason, /UNAVAILABLE/);
});

test("a directory swapped for another home's symlink before open is rejected before any read", (t) => {
  const home = fixture(t);
  const other = fixture(t);
  const originalData = path.join(home, "data");
  fs.writeFileSync(path.join(home, "data/projects.md"), "OWN_HOME");
  fs.writeFileSync(
    path.join(other, "data/projects.md"),
    "OTHER_HOME_RACE_SECRET",
  );
  const open = fs.openSync;
  const read = fs.readSync;
  let swapped = false;
  let reads = 0;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (
      !swapped &&
      args[0] === path.join(fs.realpathSync(home), "data/projects.md")
    ) {
      swapped = true;
      fs.renameSync(originalData, path.join(home, "original-data"));
      fs.symlinkSync(path.join(other, "data"), originalData);
    }
    return open(...args);
  });
  t.mock.method(fs, "readSync", (...args: any[]) => {
    reads++;
    return (read as any)(...args);
  });
  const result = loadStandingOrders(home, "supervisor");
  assert.equal(reads, 0);
  assert.equal(result.sources.length, 0);
  assert.doesNotMatch(result.text, /OTHER_HOME_RACE_SECRET/);
  assert.ok(result.warnings.some((w) => w.reason.includes("identity changed")));
});
