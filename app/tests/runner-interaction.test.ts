import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
async function waitFor<T>(
  read: () => T,
  valid: (value: T) => boolean,
): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const value = read();
    if (valid(value)) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("Fixture did not reach expected state");
}
test(
  "Codex runner starts and resumes full access while questions await typed answers and expire",
  { timeout: 20000 },
  async () => {
    for (const resume of [undefined, "native-session"]) {
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), "fm-runner-questions-"),
      );
      const executable = path.join(dir, "codex");
      const socket = path.join(dir, "runner.sock");
      const wire = path.join(dir, "wire.jsonl");
      fs.writeFileSync(
        executable,
        `#!${process.execPath}
const fs=require("node:fs");const readline=require("node:readline");
const write=m=>process.stdout.write(JSON.stringify(m)+"\\n");
readline.createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(wire)},line+"\\n");
if(m.method==="initialize")write({id:m.id,result:{}});
if(m.method==="thread/start"||m.method==="thread/resume")write({id:m.id,result:{thread:{id:"native-session"},model:"fake"}});
if(m.method==="turn/start"){
write({id:m.id,result:{turn:{id:"turn"}}});
write({method:"turn/started",params:{turn:{id:"turn"}}});
write({id:"tool-approval",method:"item/commandExecution/requestApproval",params:{}});
write({id:"question",method:"item/tool/requestUserInput",params:{questions:[{id:"choice",header:"Choose",question:"Which?",options:[{label:"A",description:"First"},{label:"B",description:"Second"}],isOther:true}]}});
}
if(m.method==="turn/interrupt"){
write({id:m.id,result:{}});
write({method:"serverRequest/resolved",params:{threadId:"native-session",requestId:"question"}});
write({method:"turn/completed",params:{turn:{id:"turn",status:"interrupted"}}});
write({method:"serverRequest/resolved",params:{threadId:"native-session",requestId:"question"}});
}
});\n`,
        { mode: 0o700 },
      );
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({
          runnerProtocol: 5,
          runnerId: "fixture",
          incarnation: 1,
          provider: "codex",
          providerId: resume,
          cwd: dir,
          model: "fake",
          executable,
          socket,
          instructions: "Fixture only",
          stage: "review",
        }),
      );
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("../src/server/runner.ts", import.meta.url)),
          path.join(dir, "config.json"),
        ],
        {
          stdio: "ignore",
          cwd: fileURLToPath(new URL("../../", import.meta.url)),
        },
      );
      const read = (file: string) =>
        fs.existsSync(file)
          ? fs
              .readFileSync(file, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : [];
      const events = () => read(path.join(dir, "events.jsonl"));
      const identity = () => {
        try {
          return JSON.parse(
            fs.readFileSync(path.join(dir, "identity.json"), "utf8"),
          );
        } catch {
          return {};
        }
      };
      const request = (payload: any) =>
        new Promise<any>((resolve, reject) => {
          const connection = net.createConnection(socket);
          let text = "";
          connection.on("connect", () =>
            connection.write(
              JSON.stringify({ id: randomUUID(), ...payload }) + "\n",
            ),
          );
          connection.on("data", (data) => {
            text += data;
            if (text.includes("\n")) {
              connection.end();
              resolve(JSON.parse(text.split("\n")[0]));
            }
          });
          connection.on("error", reject);
        });
      try {
        await waitFor(identity, (v) => v.state === "idle");
        const initial = read(wire).find(
          (m) => m.method === (resume ? "thread/resume" : "thread/start"),
        );
        assert.equal(initial.params.approvalPolicy, "never");
        assert.equal(initial.params.sandbox, "danger-full-access");
        assert.equal(
          (
            await request({
              type: "send",
              text: "Ask fixture",
              messageId: randomUUID(),
            })
          ).ok,
          true,
        );
        await waitFor(events, (list) =>
          list.some((e) => e.type === "permission.request"),
        );
        const pending = events().find(
          (e) => e.type === "permission.request",
        ).payload;
        assert.equal(pending.kind, "question");
        assert.equal(
          read(wire).some((m) => m.id === "question" && m.result),
          false,
        );
        assert.deepEqual(
          read(wire).find((m) => m.id === "tool-approval" && m.result).result,
          { decision: "accept" },
        );
        assert.deepEqual(
          read(wire).find((m) => m.method === "turn/start").params
            .sandboxPolicy,
          { type: "dangerFullAccess" },
        );
        assert.equal(
          (
            await request({
              type: "permission",
              requestId: pending.id,
              answers: { wrong: { answers: ["A"] } },
            })
          ).ok,
          false,
        );
        if (!resume) {
          assert.equal(
            (
              await request({
                type: "permission",
                requestId: pending.id,
                answers: { choice: { answers: ["B"] } },
              })
            ).ok,
            true,
          );
          await waitFor(
            () => read(wire),
            (list) => list.some((m) => m.id === "question" && m.result),
          );
          assert.deepEqual(
            read(wire).find((m) => m.id === "question" && m.result).result,
            { answers: { choice: { answers: ["B"] } } },
          );
        }
        await request({ type: "interrupt" });
        await waitFor(identity, (v) => v.state === "idle");
        assert.equal(
          (
            await request({
              type: "permission",
              requestId: pending.id,
              answers: { choice: { answers: ["A"] } },
            })
          ).ok,
          false,
        );
        assert.equal(identity().state, "idle");
      } finally {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null)
            return resolve();
          child.once("exit", () => resolve());
        });
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);
