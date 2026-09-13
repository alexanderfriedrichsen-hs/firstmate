<h1 align="center">firstmate</h1>
<p align="center">
  <a
    href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue?style=flat-square"
    ><img
      alt="Platform"
      src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue?style=flat-square"
  /></a>
  <a href="https://x.com/kunchenguid"
    ><img
      alt="X"
      src="https://img.shields.io/badge/X-@kunchenguid-black?style=flat-square"
  /></a>
  <a href="https://discord.gg/Wsy2NpnZDu"
    ><img
      alt="Discord"
      src="https://img.shields.io/discord/1439901831038763092?style=flat-square&label=discord"
  /></a>
</p>

<h3 align="center">Talk to one agent. Ship with a crew.</h3>

<p align="center">
  <img alt="firstmate - talk to one agent, ship with a crew" src="assets/banner.png" width="100%" />
</p>

## What it is

You can run one coding agent easily.
But the moment you want three project tasks done in parallel - fixes, investigations, plans, audits - you become a tab-juggler: babysitting sessions, copy-pasting context between repos, forgetting which terminal had the failing test.

firstmate flips the model.
You talk to a single agent - the first mate - and it runs the crew for you: spawning autonomous agents in a visible session backend, giving each a clean git worktree, supervising them to completion, and handing you finished PRs, approved local merges, or standalone investigation reports.
For larger fleets, you can opt in to persistent secondmates: domain supervisors that are still ordinary direct reports, but run from their own isolated firstmate homes.

firstmate is not a model, not a harness, not a skill, not an MCP server, and not a CLI.
firstmate is an agent distro for running a crew of agents.
An agent distro is a portable directory of instructions, skills, tooling, policies, and state conventions that turns a general-purpose agent into a specialized one.
There is no app to install: the cloned repo is the distro - `AGENTS.md`, bundled firstmate skills, and helper scripts that any terminal coding agent can follow.
Launching a supported harness inside it instantiates your first mate - and makes you the captain.

## Features

- **One liaison** - you talk only to the first mate; it dispatches, supervises, escalates only real decisions, and reports plain outcomes.
- **A visible crew** - every crewmate works in its own tmux window, experimental herdr/zellij tab, cmux workspace, or Orca terminal you can watch or type into; the first mate reconciles.
- **Disposable worktrees** - each task runs in a clean [treehouse](https://github.com/kunchenguid/treehouse) git worktree, or an Orca-managed worktree when `backend=orca`, so parallel work on one repo never collides.
- **Two task shapes** - ship tasks deliver a change; scout tasks investigate, plan, reproduce, or audit and leave a report.
- **Explicit project modes** - each project ships via `no-mistakes`, `direct-PR`, or `local-only`, with an optional `+yolo` autonomy flag.
- **Optional secondmates** - opt in to persistent domain supervisors that run from isolated firstmate homes with their own `FM_HOME`, state, projects, and session lock, supervising project clones or a project-less firstmate-repo domain, kept on the primary firstmate version by guarded local fast-forwards and checked for live agent processes at session start.
- **Event-driven, zero-token supervision** - a bash watcher sleeps on the fleet and wakes the first mate only when something needs you; verified primary harnesses also get a turn-end backstop that blocks or follows up on a blind stop when work is in flight and supervision is not live.
- **Optional X mode** - opt in with one local `.env` token so firstmate can answer your public `@myfirstmate` mentions, act on normal reversible mention requests through the same lifecycle as chat requests, acknowledge spawned work, and post up to three public-safe completion follow-ups within seven days for genuine milestones and the final outcome without changing non-X behavior; dry-run preview records would-be replies and dismissals locally before go-live.
- **Guarded by construction** - the first mate is read-only over your projects outside guarded clone refreshes, safe branch pruning, and approved `local-only` fast-forward merges; crewmates make every project change behind your merge approval.
- **Restart-proof** - all state lives on disk and in the active session backend (tmux by hard default, herdr or cmux when selected or auto-detected, zellij/orca when explicitly selected); kill the session anytime and the next one reconciles, including confirmed-dead secondmate agents, and carries on.
- **Localhost app (in development)** - an optional browser UI over an isolated firstmate home with native Codex, Claude, and Cursor conversations, ticket/artifact/skill browsers, vaporwave themes, and guarded legacy migration; see [Run the localhost app](#run-the-localhost-app-in-an-isolated-home).

Full detail on every feature lives in [docs/architecture.md](docs/architecture.md).

## Run the localhost app in an isolated home

The localhost app is under development.
It uses native Codex App Server conversations, subscription-authenticated Claude and Cursor sessions, SQLite write-ahead logging, and separate Treehouse leases for workers, checks, and reviews.
The browser is a client of the durable runtime.
Closing it does not cancel accepted work.
The chat follows new output automatically until you scroll up to read earlier messages.
Scroll back to the bottom or select **Jump to latest** to resume following.
Assistant replies render as sanitized Markdown, including tables and links; unsafe HTML and remote images are not rendered inline.
Routine tool activity - command executions, file changes, MCP tool calls, and web searches reported only as an audit reference - stays collapsed in the transcript by default; select **Show tool activity** to reveal it.
Searching or opening a link to a specific message reveals matching activity regardless of the toggle, and every audit record and artifact remains available either way.

To try the app, use Node.js 24.16 or later, an authenticated Codex CLI, Treehouse, and a non-live source clone.
The app currently requires a POSIX environment with Unix sockets, `ps`, and `lsof`; native Windows is not supported.
Windows Subsystem for Linux 2 (WSL 2) is unverified, so treat it as an experimental setup.
Automatic login startup is configured separately for each operating system and is not included when you clone the repository.
For Joinera, install `joinera-draft-pr-adapter` and `joinera-validation-layer` in `~/.local/bin`, or set `FIRSTMATE_JOINERA_ADAPTER` and `FIRSTMATE_JOINERA_VALIDATION_LAYER` to their absolute executable paths.
Run these commands from this checkout:

```sh
npm ci
npm run build
export FM_HOME=/absolute/path/to/isolated-firstmate-home
bin/fm-local.mjs setup --source /absolute/path/to/non-live-source --port 43170
bin/fm-local.mjs start
```

Open `http://127.0.0.1:43170`.
Dispatch starts paused.
In **Settings**, enable dispatch when you want Firstmate or workers to run.
**Human only** tickets remain outside agent API results, scheduling, dependencies with managed tickets, and compatibility exports.

To configure continuous integration (CI) evidence, pass `--required-checks "check name,another check"` to `setup`.
A PR with unknown required checks cannot satisfy CI readiness.
Only the configured source (`default`) carries required-checks configuration; registered projects added under `projects/` do not yet have their own.
Review and validation results belong to a specific clean Git revision.
Editing the source, moving the head or base, or receiving blocking feedback invalidates readiness.
An idle provider turn does not complete a ticket.

Use these commands to manage an isolated runtime:

```sh
bin/fm-local.mjs status --json
bin/fm-local.mjs pause --paused true --json
bin/fm-local.mjs backup --output /absolute/path/to/backup.sqlite --json
bin/fm-local.mjs stop --json
```

`stop` preserves provider runners.
After updating runner code, park and resume an existing conversation to load the new controls.
**Pause automatic work** pauses automated conversation input and requests interruption.
Once idle, **Park** stops that runner.
**Resume exact session** retains its provider conversation ID and refuses to start while the old runner or provider still lives.
Unknown delivery outcomes remain visible and block duplicate dispatch.

Creating a **Managed** ticket queues an automatic wake.
Editing its title, brief, priority, links, or handling, reopening it, or satisfying its dependencies also queues a wake, including for tickets that were waiting on the one that just became satisfied.
Firstmate picks it up when dispatch is enabled, its conversation is idle, and you have returned control to automation.
**Pause automatic work** retains your input ownership until you select **Enable automatic work**, even after you close the browser.
To switch the Codex model for future turns, select **Model** in an idle conversation with no pending input.
Choose a supported **Thinking effort** or use the model default; both settings apply to future turns.
The sidebar **Needs your review** badge counts tickets awaiting your decision and opens the first one.
To start fresh, select **New chat** in Firstmate.
Previous chat history and tickets remain available, and the new chat starts under your control.
Installed skills remain discoverable from the same workspace; old conversation context does not carry over.
Skills that require legacy terminal orchestration still need adaptation to the native app runtime.

Use **Skills** to search and read the native catalog or add an explicit skill to your next message.
Use **Context** to inspect captured launch instructions, prepared skill inputs, and provider-reported Markdown reads by session.
Provider-internal reads and unrecorded older context are not observable.
Use **Artifacts** or a file link in chat to open collected reports, images, HTML, and PDFs inside the app.
The runtime collects supported files from each session's `outputs` directory and recent assistant links inside its workspace after a turn.
HTML previews run in an isolated frame without network access.
**Dashboards** separates Firstmate usage from available Codex account allowance and account-wide activity.
Subscription invoices and a separate count of unrelated activity are unavailable from provider metadata.
In **Settings > Appearance**, choose system, vaporwave light, or vaporwave dark.

To inspect legacy state, use a separate isolated staging home and `import --source /absolute/path/to/legacy-home`.
Import reads backlog and targeted metadata and status files without running legacy scripts.
Shadow mode cannot start provider sessions or enable dispatch.
Reimport preserves ticket IDs and reports competing local edits.

To prepare migration, pause dispatch and stop the app runtime before running commands that acquire ownership.
First rehearse against an operational copy of the legacy home.
Keep the legacy Firstmate and watcher paused during installation and transfer; retain workers as externally managed sessions.
From the staging home, run `fence-install --source /absolute/path/to/legacy-home --json`.
Review the exact source and target hashes, local-edit checks, and blockers, then run `fence-install --approve-report <id>`.
Installation preserves originals and rejects changed files or active owners.
For operational homes without Git metadata, review the existing file hashes explicitly because no clean Git baseline is available.
If installation stops partway through, rerun the same approved report; unexpected edits block recovery.

Run `cutover --source /absolute/path/to/legacy-home --json` to prepare the transfer report.
After reviewing a ready report, run `cutover --approve-report <id>` from the same staging home.
Transfer backs up legacy state, installs a persistent ownership marker, imports the final state, and publishes a paused app database.
If transfer stops before completion, run `cutover --recover --approve-report <id>` from the original staging home.
If recovery cannot continue, `cutover-abort --approve-report <id>` releases an unchanged incomplete transfer and preserves the partial app image in the backup.
Abort refuses completed transfers, changed app images, or ambiguous worker activity.

Start the transferred home with `start --home /absolute/path/to/legacy-home --transferred-home`.
The canonical live home requires a matching completed receipt and app ownership marker.
Verify imported tickets and retained worker identities before enabling automatic dispatch.
Legacy workers remain externally managed; migration does not silently attach or restart them.
Restart the legacy controller or watcher manually only after a successful rollback releases app ownership.

Adoption applies only to a queued or backlog ticket still marked externally managed with agent-managed handling; the app rejects any other ticket outright.
If the imported ticket names a specific repository, it must match an available registered project before adoption becomes eligible.
The native project catalog includes the configured source as `default` and clones under this home's `projects/` listed in `data/projects.md`.
Read the scoped `projects` resource and set `projectId` on ticket creation or update before launching a worker.
An unambiguous GitHub PR reference can resolve an existing ticket's project; otherwise, multiple available projects require explicit selection.
An unknown or no-longer-available `projectId`, or one that contradicts the ticket's repository hint or linked PR, is rejected until you correct the association.
Worker, review, repair, and check leases stay bound to that project.
Initial worker allocation uses a bounded asynchronous wait.
If allocation fails before a native session starts, Firstmate reconciles the original launch up to three times, checks for surviving allocator processes and exact lease ownership, and preserves queued input.
Use `conversation.reconcileLaunch` or the conversation recovery action after correcting a remaining blocker; launches with native identities require their existing resume workflow.
Native validate, review, and CI checks currently run only for the configured `default` project or a Joinera remote; other registered projects cannot launch checks yet.
To correct an old ticket's repository, park and settle its workers, update `projectId`, and create a new worker; old chats keep their original workspace and history.
Tickets with frozen revisions cannot change projects.
Conflicting legacy updates, non-descriptive legacy metadata, prior status history, holds, existing worker attempts, or an outstanding adoption conversation block adoption until you reconcile them.
Adopting a ticket always requires your explicit **Adopt queued ticket** action in the ticket detail view; the app never automatically takes over a retained worker.

`rollback --output /absolute/path/to/export-directory` exports current history without releasing ownership.
To release ownership, pause dispatch, park app-native sessions, stop the runtime, and run `rollback --release-ownership --output /absolute/path/to/export-directory` against the transferred home.
Review the report, then run `rollback --release-ownership --approve-report <id>` with the same home.
Include `--transferred-home` when the target is the canonical live home.
Rollback exports managed history and private Human only records separately, retains the app database, and removes the ownership marker.
It leaves legacy state unchanged; reconcile the managed export before manually restarting legacy supervision.
Repeat the same approved rollback command if receipt publication or marker removal was interrupted.
Released app history supports inspection and backup, but cannot restart a runtime.

To retire an app-owned checkout, run `lease-retire --kind conversation --target-id <id> --landed-ref refs/remotes/origin/main` against a paused, stopped app home.
Use `--kind check` for a check job.
Refresh the repository's tracking ref before preparing a landed-work report.
For unlanded scratch work, use `--scratch-artifact <artifact-id> --reason <text>` instead.
Review the report, then run `lease-retire --approve-report <id>` from the same home.
Retirement checks the exact lease, clean checkout, settled sessions, and preserved evidence, then returns the lease without force.

Codex streaming, permission replies, takeover, exact resume, native worker dispatch, and independent revision-bound review have isolated integration coverage.
Claude worker startup, exact-session resume, streaming, question responses, and interruption have isolated coverage.
To sign in to Claude or Cursor, open **Settings > Providers** and select **Sign in**.
The native provider CLI opens your default browser, and the app refreshes connection status after you finish authentication.
Credentials stay in the provider's native credential store; the app does not collect passwords or store authentication links in browser storage.
Install the provider CLI if the sign-in button reports it missing.
To switch Firstmate providers, select **New chat**, choose a provider, model, and supported thinking effort, and create the chat.
Your previous conversation remains available, and the new chat starts with automatic work paused.
Use **Model** to change the model and supported effort for the next turn with the current provider.

Type `/` at the start of the composer to browse skills and commands, then type to filter the list.
Use the arrow keys to choose an item, Enter or Tab to select it, and Escape to close the list.
Selecting a Codex skill attaches it to your next message; selecting a provider command inserts its text for you to send.
Claude and Cursor commands appear only after the provider advertises them for that conversation, so the list can be empty before the first turn.
The app commands `/skills`, `/artifacts`, and `/context` open the corresponding browser tabs.
Outside the picker, Enter sends your message and Shift+Enter adds a line.
You can attach up to four skills to a message; selecting a fifth shows an error instead of dropping an existing choice.
Remove a single attached skill with its chip's close control, which leaves the others in place.

Cursor uses its native Agent Client Protocol (ACP) connection and your signed-in subscription.
Reported session usage appears in the app when the provider supplies it; missing usage is not treated as zero.
The app does not enforce an account-wide token cap or change subscription billing settings.
As configured for this app, Codex, Claude, and Cursor run with full tool access, including review conversations.
The app uses native full-access settings and automatically grants supported tool permission requests; provider and operating system limits still apply.
Actual questions and plan decisions appear in the conversation and wait for your answer.
Recognized empty-form Codex app tool authorization requests are accepted automatically with the native response format.
MCP forms that require supported scalar values remain questions; sign-in links require you to complete authentication before continuing.
Unsupported forms or provider requests show a stop-and-resume notice instead of an approval button. Optional fields and complex form schemas are not yet supported.
Expired request replies are never retried; reconciliation records uncertain prior delivery without claiming that it succeeded or never happened.
To apply this policy to a retained runner from an older release, interrupt and park it, then resume the same chat.
Protocol fixtures cover permissions and session transport; they do not establish full native provider verification.

Heartbeat is enabled by default.
Fleet reviews run every ten minutes; configure their interval in **Settings > Heartbeat** (1-120 minutes).
Native health checks run at least every five minutes, and retained worker status observations run every 15 seconds.
Checks inspect runner identities, working directories, lease retirement, and delayed or uncertain dispatches without running legacy watcher scripts.
Active managed or retained work receives an interval review opportunity.
Firstmate reports meaningful progress or actions and acknowledges unchanged observations silently; empty healthy fleets do not start a model turn.
Scheduled fleet-heartbeat prompts appear in chat collapsed under **Scheduled fleet review**, expandable on demand; the model and audit trail always receive the full prompt text, and a user cannot spoof this provenance by resending the same text.
Chat history predating this behavior is authenticated retroactively from its recorded dispatch, so older scheduled prompts also render collapsed.
Automatic delivery waits while dispatch is paused, Firstmate is busy, a question needs your answer, or you have taken over.
Retained external workers remain observation-only. A quiet running session is a reason to check progress, not proof that it has stalled.
The dashboard shows the last completed runtime loop, the last and next fleet checks, and health concerns. A loop older than one minute is stale.
A **Heartbeat needs attention** button appears in the footer when a loop goes stale or a check reports issues, and jumps to the dashboard.
A heartbeat retries at most three presentations, ten minutes apart, until Firstmate acknowledges it with `wake.ack`.
Exhausted presentations remain recorded as missed acknowledgements; later fleet reviews continue.
Disabling cancels pending heartbeat dispatch without interrupting an active turn.
Each Firstmate startup or exact-session resume loads bounded standing orders from its own home, records the source files and scoped fleet snapshot in Context, and queues a startup review.
Automatic recovery resumes a lost Firstmate only after both recorded processes are dead and pending effects are reconciled; three attempts are allowed until a successful turn resets the budget.
Retained GitHub PR links receive bounded read-only state observations every five minutes.
These observations never establish native CI acceptance or change ticket ownership or completion.
Settings lists remaining parity gaps: arbitrary legacy check hooks, authoritative legacy endpoint probing, secondmate recovery and routing, and all legacy delivery modes plus per-project check configuration.

To validate changes, run `npm run typecheck`, `npm test`, and `bin/fm-lint.sh`.
The browser test uses an installed Chrome and a 10,000-message isolated fixture.
Raw provider journals and local validation fixtures belong under ignored data directories.
Generated protocol types come from `npm run protocol`; edit their generator inputs or adapter code instead of editing those types.

## Quick Start

### Requirements

- A verified agent harness: Claude Code, Grok, Pi, Codex, or OpenCode.
- Git and the GitHub CLI, authenticated through `gh auth login`.
- tmux, for the reference session backend.

The first mate detects and offers to install everything else.

### Recommended harnesses

**Claude Code, Grok, and Pi are equal co-primary recommendations** for running the primary firstmate session.
Claude Code and Grok use background-notify wake cycles; Pi uses its tracked primary watcher extension.
All three have verified turn-end guard paths when launched with their documented setup.
Pick whichever one matches your subscription and workflow.

Codex and OpenCode are also verified and supported as primary harnesses; Codex uses bounded foreground checkpoints, and OpenCode uses a TUI plugin, so both carry more harness-specific supervision tradeoffs than the three co-primaries.

### Install and launch

```sh
gh auth login
git clone https://github.com/kunchenguid/firstmate
cd firstmate
```

Then launch one of the co-primary harnesses; AGENTS.md takes over from there:

**Claude Code**

```sh
claude
```

**Grok**

```sh
grok --trust
```

**Pi**

```sh
pi
```

For Grok, `--trust` is needed once per clone so project hooks and the turn-end guard load; `/hooks-trust` inside Grok works too.
For Pi, approve the project trust prompt once per clone on first launch so both tracked `.pi/extensions/*.ts` files auto-load.

### Talk to it

```sh
> ahoy! look at my github project xyz, then fix the flaky login test and add dark mode

# firstmate checks its toolchain (asking your consent before installing anything),
# clones the project under projects/, and spawns two crewmates in the active backend
# fm-fix-login-k3 and fm-dark-mode-p7.
# Minutes later:

  PR ready for review, captain: https://github.com/you/xyz/pull/42
  (fix flaky login test - risk: low - CI green)

> alright merge it
```

### More backends

Setup guides for tmux (the default) and every other supported backend (herdr, zellij, Orca, cmux) are linked in [Documentation](#documentation) below.

## How It Works

```
            you (the captain)
                  │  chat: requests, decisions, "merge it"
                  ▼
 ┌─────────────────────────────────────┐
 │ firstmate            (this repo)    │
 │ reads projects/ + firstmate routes  │
 │ writes guarded backlog/briefs/state │
 └──┬──────────────┬───────────────┬───┘
    │ backend sends / status files │
    ▼              ▼               ▼
 ┌────────┐   ┌────────┐      ┌────────┐
 │fm-task1│   │fm-task2│  ... │fm-taskN│   tmux windows, herdr/zellij tabs, cmux workspaces, or Orca terminals
 │crewmate│   │crewmate│      │crewmate│   one autonomous agent each
 └───┬────┘   └───┬────┘      └───┬────┘
     ▼            ▼               ▼
  treehouse worktree, Orca worktree, or isolated secondmate home
     │
     ├─ ship: project mode ► PR/local merge ► teardown
     │
     └─ scout: report at data/<id>/report.md ► relay findings ► teardown
```

You chat with the first mate.
It routes each request to a crewmate in its own session endpoint and git worktree, supervises the fleet with a zero-token event-driven watcher, and brings you finished PRs, approved local merges, or investigation reports.
Optional secondmates extend this to persistent domain supervisors, dispatch profiles let you steer which harness handles which task, and an opt-in X mode lets the same fleet answer public mentions.
`codex-app` is not a runtime backend yet; [docs/codex-app-backend.md](docs/codex-app-backend.md) owns the Codex App boundary.

Full architecture - the supervision engine, worktree isolation, secondmates, dispatch profiles, project modes, optional X mode, fleet sync, and self-update - is in [docs/architecture.md](docs/architecture.md).

## Built-in skills

Firstmate ships these user-invocable built-in skills.
Claude and grok use the slash form shown here; codex uses the same names with `$`, such as `$afk`.

| Skill              | What it does                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `/afk`             | Enter away-mode supervision: the sub-supervisor self-handles routine wakes in bash, escalates captain-relevant events and bounded declared-external-wait rechecks as batched digests, and actively alerts if delivery wedges while you step away |
| `/bearings`        | Generate a standalone current-status report from bounded local fleet and registered-secondmate state, with live PR enrichment only when requested, written to a dated file in `data/` and surfaced concisely in chat; read-mostly, mutates no task state |
| `/updatefirstmate` | Self-update the running firstmate and its secondmates to the latest from origin with fast-forward-only pulls, then re-read instructions and nudge secondmates |
| `/stow`            | Sweep the session for uncaptured durable knowledge, route each finding to its disk home per AGENTS.md, file undone next steps to the backlog, and report what is now safe to reset |
| `/standup`         | Compose short, speakable first-person standup bullets - what I worked on and where I'm going - from the session, backlog, bearings reports, the captain's own Codex chats, and their personal git commits, written to a dated file in `data/` and echoed in chat; read-mostly, its only write is the standup file |

Agent-only reference skills live under `.agents/skills/` and are loaded by firstmate at the trigger points named in [`AGENTS.md`](AGENTS.md).

### Two-tier skill layout

Firstmate's skills live in two separate places with different audiences:

- `.agents/skills/` - agent-loaded skills (this section's table, plus firstmate's agent-only reference skills). Every one of these assumes a live firstmate home and is meaningless, or actively misleading, installed anywhere else, so each carries `metadata.internal: true` in its frontmatter. That flag hides them from installer discovery (tools like the [skills.sh](https://skills.sh) `npx skills add` installer) without affecting how firstmate itself loads them - frontmatter metadata is inert to the agent's own skill loader.
- `skills/` - public, installer-facing skills meant to be installed standalone into any project, independent of firstmate.
  Each one is a self-contained skill with no dependency on firstmate's paths, tools, or vocabulary.
  Today that is `skills/stow`, a generic session-knowledge-sweep skill that routes findings by explicit instruction first, then existing local conventions, then a private `.stow-notes.md` fallback in the current directory, and closes with a resume pointer for the next session.
  It intentionally shares no code with the firstmate-internal `.agents/skills/stow` it is named after, so the two can evolve independently.

## Documentation

- [docs/architecture.md](docs/architecture.md) - how the crew, supervision, worktrees, secondmates, and project modes work.
- [docs/configuration.md](docs/configuration.md) - environment variables, `FM_HOME`, runtime backend selection, optional X mode, the files you set, and harness support.
- [docs/wedge-alarm.md](docs/wedge-alarm.md) - configure the active alert for a wedged away-mode escalation delivery.
- [docs/tmux-backend.md](docs/tmux-backend.md) - setup guide for the tmux reference backend: prerequisites, attaching, and watching crew windows.
- [docs/herdr-backend.md](docs/herdr-backend.md) - setup guide for the experimental herdr backend, plus its verification notes and known gaps.
- [docs/zellij-backend.md](docs/zellij-backend.md) - setup guide for the experimental zellij backend, plus its verification notes and known gaps.
- [docs/orca-backend.md](docs/orca-backend.md) - setup guide for the experimental Orca backend, plus its lifecycle notes and known gaps.
- [docs/cmux-backend.md](docs/cmux-backend.md) - setup guide for the experimental cmux backend, plus its verification notes and known gaps.
- [docs/codex-app-backend.md](docs/codex-app-backend.md) - Codex App backend boundary, evidence, and rollout contract.
- [docs/turnend-guard.md](docs/turnend-guard.md) - the primary session's structural "no turn ends blind" backstop: verified per-harness hook mechanisms, scoping, loop safety, and fail-open tradeoffs.
- [docs/supervision-protocols/](docs/supervision-protocols/) - rendered primary-harness watcher protocols for Claude, Codex, OpenCode, Pi, Grok, and unknown harness fallback.
- [docs/scripts.md](docs/scripts.md) - the `bin/` toolbelt reference.
- [`AGENTS.md`](AGENTS.md) - the distro's core instruction file and the first mate's full operating manual.
- [CONTRIBUTING.md](CONTRIBUTING.md) - how to contribute, including the dev/test commands.

## Contributing

Contributions are welcome - see [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, repo conventions, and how to run the tests.

## License

MIT - see [LICENSE](LICENSE).
