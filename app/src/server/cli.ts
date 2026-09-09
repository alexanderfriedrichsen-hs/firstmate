#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encode } from "@toon-format/toon";
import { Store } from "./store.ts";
import { homePath, ownHome, processIdentity, alive, atomic } from "./home.ts";
import { Runtime } from "./runtime.ts";
import { serve } from "./http.ts";
import {
  importLegacy,
  rollbackExport,
  prepareCutover,
  executeCutover,
  recoverCutover,
  abortCutover,
  prepareRollback,
  executeRollback,
} from "./migration.ts";
import { prepareFenceInstall, executeFenceInstall } from "./fence-install.ts";
import { prepareLeaseRetirement, executeLeaseRetirement } from "./leases.ts";
const help = `Firstmate localhost application\n\nFM_HOME must be an explicit isolated absolute path.\n\nCommands:\n  setup --source <non-live clone> [--port 43170] [--required-checks name,name]\n  start                         Start the runtime in the foreground\n  status                        Show local runtime and tickets\n  stop                          Stop runtime; preserve provider runners\n  pause --paused <true|false>    Change automatic dispatch state\n  reconcile                     Read runner identities and pending effects\n  backup --output <path>         Create a consistent SQLite backup\n  import --source <legacy copy>  Import a read-only legacy copy\n  rollback --output <directory>  Export current managed and user-only history\n    --release-ownership         Prepare rollback report; approve separately\n    --approve-report <id>       Export and release app ownership\n  fence-install --source <home> Prepare reviewed legacy entrypoint installation\n    --approve-report <id>       Install the exact approved snapshot\n  lease-retire --kind <conversation|check> --target-id <id>\n    --landed-ref <ref>          Require HEAD landed on the recorded main ref\n    --scratch-artifact <id> --reason <text>  Preserve unlanded scratch evidence\n    --approve-report <id>       Return the inspected lease, without force\n  cutover --source <home>        Prepare a read-only transfer report\n    --approve-report <id>       Execute that explicitly approved fresh report\n    --recover --approve-report <id>  Complete an interrupted transfer\n  cutover-abort --approve-report <id>  Release an unchanged incomplete transfer\n  read [--resource snapshot|wakes|tickets/<id>]  Read scoped agent state\n  command --file <json> --token-file <path>  Submit an agent command\n\nOptions: --help, --json, --home <path>, --transferred-home.\n--transferred-home requires a complete ownership receipt for the live home.\nUnknown options fail.\n\nExamples:\n  FM_HOME=/absolute/test-home npm run app -- setup --source /absolute/source\n  FM_HOME=/absolute/test-home npm start\n  FM_HOME=/absolute/test-home npm run app -- status --json`;
const jsonRequested = process.argv.includes("--json");
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      json: { type: "boolean" },
      home: { type: "string" },
      source: { type: "string" },
      port: { type: "string" },
      "required-checks": { type: "string" },
      "approve-report": { type: "string" },
      "transferred-home": { type: "boolean" },
      "release-ownership": { type: "boolean" },
      recover: { type: "boolean" },
      kind: { type: "string" },
      "target-id": { type: "string" },
      "landed-ref": { type: "string" },
      "scratch-artifact": { type: "string" },
      reason: { type: "string" },
      output: { type: "string" },
      paused: { type: "string" },
      file: { type: "string" },
      resource: { type: "string" },
      "token-file": { type: "string" },
    },
  });
  if (values.help) {
    console.log(help);
    process.exit(0);
  }
  const command = positionals[0] ?? "status";
  if (positionals.length > 1)
    throw new Error("Unexpected argument. Use --help.");
  const valid: Record<string, string[]> = {
    setup: ["source", "port", "required-checks"],
    start: [],
    status: [],
    stop: [],
    pause: ["paused"],
    reconcile: [],
    backup: ["output"],
    import: ["source"],
    rollback: ["output", "release-ownership", "approve-report"],
    cutover: ["source", "approve-report", "recover"],
    "cutover-abort": ["approve-report"],
    "fence-install": ["source", "approve-report"],
    "lease-retire": [
      "kind",
      "target-id",
      "landed-ref",
      "scratch-artifact",
      "reason",
      "approve-report",
    ],
    command: ["file", "token-file"],
    read: ["resource", "token-file"],
  };
  if (!valid[command]) throw new Error("Unknown command. Use --help.");
  for (const key of Object.keys(values))
    if (
      !["help", "json", "home", "transferred-home", ...valid[command]].includes(
        key,
      )
    )
      throw new Error(
        `Unknown option --${key} for ${command}. Valid: ${valid[command].join(", ")}`,
      );
  if (process.env.FM_AGENT_TOKEN_FILE && !["read", "command"].includes(command))
    throw new Error(
      "Agent sessions must use scoped read or command operations",
    );
  const home = homePath(values.home, {
    allowTransferred: values["transferred-home"],
    allowReleasedRecovery:
      ["status", "reconcile", "backup"].includes(command) ||
      (command === "rollback" &&
        !!values["release-ownership"] &&
        !!values["approve-report"]),
    rollbackReportId:
      command === "rollback" ? values["approve-report"] : undefined,
  });
  const print = (data: any) =>
    console.log(values.json ? JSON.stringify(data) : encode(data));
  const info = () => {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(home, "app", "runtime.json"), "utf8"),
      );
    } catch {
      return null;
    }
  };
  if (command === "stop") {
    const identity = info();
    if (identity && alive(identity.pid, identity.startIdentity))
      process.kill(identity.pid, "SIGTERM");
    print({ stopped: !!identity, runners: "preserved" });
    process.exit(0);
  }
  if (command === "command" || command === "read") {
    const tokenFile = values["token-file"] ?? process.env.FM_AGENT_TOKEN_FILE;
    if ((command === "command" && !values.file) || !tokenFile)
      throw new Error(
        "A command file and scoped agent credential are required",
      );
    const runtime = info();
    if (!runtime) throw new Error("Start the runtime first");
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    const resource =
      command === "command" ? "commands" : (values.resource ?? "snapshot");
    if (
      !/^(snapshot|wakes|usage|tickets\/[a-f0-9-]+|conversations\/[a-f0-9-]+)$/.test(
        resource,
      ) &&
      command === "read"
    )
      throw new Error("Unsupported read resource");
    const response = await fetch(
      `http://127.0.0.1:${runtime.port}/v1/${resource}`,
      {
        method: command === "command" ? "POST" : "GET",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body:
          command === "command"
            ? fs.readFileSync(values.file!, "utf8")
            : undefined,
      },
    );
    print(await response.json());
    process.exit(response.ok ? 0 : 1);
  }
  // Read-only status uses SQLite without acquiring or replacing runtime ownership.
  if (command === "status" || command === "reconcile") {
    const store = new Store(home, true);
    print({
      runtime: info(),
      policy: store.setting("policy"),
      tickets: store
        .tickets({ kind: "user", id: "operator" })
        .map((t) => ({ id: t.id, title: t.title, status: t.status })),
      pendingEffects: store.db
        .prepare(
          "SELECT kind,state,target_id FROM outbox WHERE state IN ('dispatching','uncertain')",
        )
        .all(),
    });
    store.db.close();
    process.exit(0);
  }
  if (command === "backup") {
    if (!values.output) throw new Error("--output is required");
    const readOnlyStore = new Store(home, true);
    await readOnlyStore.backup(path.resolve(values.output));
    readOnlyStore.db.close();
    print({ backup: path.resolve(values.output) });
    process.exit(0);
  }
  if (
    command === "pause" &&
    info() &&
    alive(info().pid, info().startIdentity)
  ) {
    if (!["true", "false"].includes(values.paused ?? ""))
      throw new Error("--paused must be true or false");
    const base = `http://127.0.0.1:${info().port}`;
    const session = await fetch(base + "/v1/session");
    const cookie = session.headers.get("set-cookie")?.split(";")[0] ?? "";
    const { csrf } = await session.json();
    const response = await fetch(base + "/v1/commands", {
      method: "POST",
      headers: {
        cookie,
        Origin: base,
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        type: "runtime.pause",
        payload: { paused: values.paused === "true" },
      }),
    });
    print(await response.json());
    process.exit(response.ok ? 0 : 1);
  }
  const release = ownHome(home);
  const store = new Store(home);
  const migrationCommand = [
    "cutover",
    "cutover-abort",
    "fence-install",
    "rollback",
  ].includes(command);
  if (
    store.setting("ownershipReleased") &&
    !(
      command === "rollback" &&
      values["release-ownership"] &&
      values["approve-report"]
    )
  )
    throw new Error(
      "App ownership was released; only retained-history reads and approved rollback recovery are allowed",
    );
  if (store.setting("transferDestination") && !migrationCommand)
    throw new Error(
      "This staging home transferred ownership to " +
        store.setting("transferDestination") +
        "; use it only for retained history",
    );
  if (!store.setting("ownershipReleased")) store.fence();
  if (
    !migrationCommand &&
    !fs.existsSync(path.join(home, "app", "control-mode"))
  )
    atomic(
      path.join(home, "app", "control-mode"),
      JSON.stringify({
        mode: "app",
        home,
        createdAt: new Date().toISOString(),
      }),
    );
  if (command === "setup") {
    if (!values.source) throw new Error("--source is required");
    const source = fs.realpathSync(values.source);
    if (source.includes("/.firstmate"))
      throw new Error("Use a non-live source clone");
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: source,
      encoding: "utf8",
    }).trim();
    const port = Number(values.port ?? 43170);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error("Invalid port");
    store.setting("project", {
      source,
      remote,
      profile: "code_only",
      requiredChecks:
        values["required-checks"]
          ?.split(",")
          .map((s) => s.trim())
          .filter(Boolean) ?? [],
    });
    store.setting("port", port);
    print({
      configured: true,
      home,
      port,
      profile: "code_only",
      dispatch: "paused",
    });
  } else if (command === "start") {
    const port = store.setting("port") ?? 43170;
    const runtime = new Runtime(store);
    const web = serve(store, port);
    await web.start();
    atomic(
      path.join(home, "app", "runtime.json"),
      JSON.stringify({
        pid: process.pid,
        startIdentity: processIdentity(),
        generation: store.generation,
        port,
      }),
    );
    runtime.start();
    print({
      url: `http://127.0.0.1:${port}`,
      home,
      generation: store.generation,
      dispatch: store.setting("policy").paused ? "paused" : "enabled",
    });
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      runtime.stop();
      web.close();
      store.db.pragma("wal_checkpoint(FULL)");
      release();
      process.exit(0);
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    await new Promise(() => {});
  } else if (command === "pause") {
    if (store.setting("shadowMode") && values.paused === "false")
      throw new Error("Shadow mode cannot dispatch work");
    if (!["true", "false"].includes(values.paused ?? ""))
      throw new Error("--paused must be true or false");
    store.setting("policy", {
      ...store.setting("policy"),
      paused: values.paused === "true",
    });
    print({ paused: values.paused === "true" });
  } else if (command === "backup") {
    if (!values.output) throw new Error("--output is required");
    await store.backup(path.resolve(values.output));
    print({ backup: path.resolve(values.output) });
  } else if (command === "rollback") {
    if (values["approve-report"] && !values["release-ownership"])
      throw new Error("--approve-report requires --release-ownership");
    if (values["release-ownership"]) {
      if (values["approve-report"]) {
        const report = store.setting(
          "rollbackReport:" + values["approve-report"],
        );
        if (!report)
          throw new Error("Prepare and review a rollback report first");
        print(
          await executeRollback(store, report, values["approve-report"], {
            ownershipHeld: true,
          }),
        );
      } else {
        if (!values.output) throw new Error("--output is required");
        print(prepareRollback(store, path.resolve(values.output)));
      }
    } else {
      if (!values.output) throw new Error("--output is required");
      print(await rollbackExport(store, path.resolve(values.output)));
    }
  } else if (command === "cutover") {
    if (values.recover && !values["approve-report"])
      throw new Error("--recover requires --approve-report");
    if (values["approve-report"]) {
      const report = store.setting("cutoverReport:" + values["approve-report"]);
      if (!report) throw new Error("Prepare and review a cutover report first");
      print(
        await (values.recover ? recoverCutover : executeCutover)(
          store,
          report,
          values["approve-report"],
        ),
      );
    } else {
      if (!values.source)
        throw new Error("--source is required to prepare a cutover report");
      print(
        prepareCutover(
          store,
          values.source,
          fileURLToPath(new URL("../../../", import.meta.url)),
        ),
      );
    }
  } else if (command === "cutover-abort") {
    if (!values["approve-report"])
      throw new Error("--approve-report is required");
    const report = store.setting("cutoverReport:" + values["approve-report"]);
    if (!report) throw new Error("Prepare and review a cutover report first");
    print(await abortCutover(store, report, values["approve-report"]));
  } else if (command === "fence-install") {
    if (values["approve-report"]) {
      const report = store.setting(
        "fenceInstallReport:" + values["approve-report"],
      );
      if (!report)
        throw new Error("Prepare and review a fence installation report first");
      print(executeFenceInstall(report, values["approve-report"]));
    } else {
      if (!values.source) throw new Error("--source is required");
      const report = prepareFenceInstall(
        values.source,
        fileURLToPath(new URL("../../../", import.meta.url)),
      );
      store.setting("fenceInstallReport:" + report.id, report);
      print(report);
    }
  } else if (command === "lease-retire") {
    if (values["approve-report"]) {
      const report = store.setting(
        "leaseRetirementReport:" + values["approve-report"],
      );
      if (!report)
        throw new Error("Prepare and review a lease retirement report first");
      print(
        executeLeaseRetirement(store, report.request, values["approve-report"]),
      );
    } else {
      if (
        !["conversation", "check"].includes(values.kind ?? "") ||
        !values["target-id"]
      )
        throw new Error(
          "--kind conversation|check and --target-id are required",
        );
      if (!!values["scratch-artifact"] !== !!values.reason)
        throw new Error(
          "--scratch-artifact and --reason must be provided together",
        );
      const report = prepareLeaseRetirement(store, {
        kind: values.kind as "conversation" | "check",
        targetId: values["target-id"],
        landedRef: values["landed-ref"],
        scratch: values["scratch-artifact"]
          ? { artifactId: values["scratch-artifact"], reason: values.reason! }
          : undefined,
      });
      store.setting("leaseRetirementReport:" + report.reportId, report);
      print(report);
    }
  } else if (command === "import") {
    if (!values.source) throw new Error("--source is required");
    print(importLegacy(store, values.source));
  }
  store.db.close();
  release();
} catch (error) {
  const result = { error: String(error), help: "Run bin/fm-local.mjs --help" };
  console.log(jsonRequested ? JSON.stringify(result) : encode(result));
  process.exitCode = 1;
}
