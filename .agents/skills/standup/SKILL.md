---
name: standup
description: Compose short, speakable first-person standup bullets - what I worked on and where I'm going - from this session, the backlog, bearings reports, the captain's own Codex chats, and their personal git commits, written to data/standup-<YYYY-MM-DD>.md and echoed in chat. Use when the captain invokes /standup, asks for standup bullets, "what did I work on yesterday", "prep for standup", or wants speakable notes to read aloud to teammates. It is read-mostly - its only write is the standup file, and it never tears down, merges, steers, or mutates backlog or task state as a side effect.
user-invocable: true
metadata:
  internal: true
---

# standup

Compose the captain's standup bullets: short, speakable, first-person answers to "what I worked on" and "where I'm going", ready to read aloud to teammates.
The operating rhythm this serves is one firstmate session per day: each morning the captain runs `/stow` then `/standup` in the session that has been running since the previous morning, attends standup, then exits and starts fresh.
That rhythm makes this session's own conversation history the primary record of the previous day's supervised work.

## Reporting window

The window runs from the most recent `data/standup-<YYYY-MM-DD>.md` dated older than today, when one exists, to now.
When no such file exists, use the last 24 hours.
State the window in one line at the top of the output, in both the file and the chat.

```sh
prev=$(ls data/standup-*.md 2>/dev/null | grep -v "standup-$(date +%F).md" | sort | tail -1)
```

When `prev` is non-empty, the window start is the date in its filename; otherwise it is 24 hours ago.

## Sources

Gather from these sources in order.
Each degrades gracefully: a missing source is silently skipped, never an error.

1. **This session's own conversation history.**
   With one session per day, this conversation IS the record of the previous day's fleet-supervised work - no transcript parsing needed.
   Recall what was delivered, approved, fixed, decided, and discussed, including anything the captain said about upcoming direction.

2. **`data/backlog.md`.**
   Done entries dated inside the window, In flight items' latest dated progress notes (PRs delivered, approvals, fix rounds), and Queued items awaiting the captain.
   Read it directly; do not mutate it.

3. **Bearings reports.**
   Any `data/status-report-*.md` dated inside the window, when present.

4. **The captain's own Codex chats.**
   Skip this source entirely when `~/.codex` does not exist.
   `~/.codex/history.jsonl` is JSONL with one `{"session_id": "...", "ts": <epoch seconds>, "text": "<the user prompt>"}` per line.
   Full transcripts live at `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<session_id>.jsonl`, whose FIRST line is `type=session_meta` with `payload.cwd` and `payload.originator`.
   Filter history lines to the window by `ts`, then resolve each distinct `session_id` to its rollout file to read `cwd`:

   ```sh
   since=<window start as epoch seconds>
   [ -f ~/.codex/history.jsonl ] && jq -r --argjson since "$since" \
     'select(.ts >= $since) | [.session_id, .ts, .text] | @tsv' ~/.codex/history.jsonl
   ```

   ```sh
   f=$(find ~/.codex/sessions -name "rollout-*-<session_id>.jsonl" 2>/dev/null | head -1)
   [ -n "$f" ] && head -1 "$f" | jq -r '.payload.cwd'
   ```

   EXCLUDE fleet-driven sessions so the bullets only reflect the captain's own hands-on work, by BOTH rules: drop any prompt whose text starts with the `[fm-from-firstmate]` marker, and drop any session whose `cwd` is a disposable agent worktree rather than a personal checkout - for example under `~/.treehouse/`, this firstmate home or any secondmate home, a no-mistakes gate worktree under `~/.no-mistakes/worktrees/`, or an Orca-managed worktree.
   When in doubt about a `cwd`, leave the session out rather than misattribute agent work as the captain's own.
   Summarize the captain's own sessions from the prompt texts; open a rollout transcript only when a prompt alone is too thin to name the work.

5. **The captain's own git commits.**
   For each distinct personal checkout `cwd` discovered in step 4 (for example a clone under `~/code/`), run a read-only log:

   ```sh
   git -C "$cwd" log --since="<window start>" --author="$(git -C "$cwd" config user.email)" --oneline
   ```

   Personal checkout locations come from the Codex session cwds; never hardcode them.

## Output contract

- Write the report to `data/standup-<YYYY-MM-DD>.md` using today's date, and print the same bullets in chat.
- State the reporting window in one line at the top.
- Sections: `## Since last standup` (or `## Yesterday` when the window is roughly one day), `## Today`, and an optional `## Waiting on` for pending reviews and decisions when relevant.
- 4-8 bullets per section, most important first, each speakable in one breath.
- `## Today` draws from: in-flight work close to landing, queued items whose blockers cleared, items awaiting the captain's own action, and anything the captain said in-session about upcoming direction.
- Every PR reference is a full `https://...` URL, never a bare `#number`.

## Voice rules

- First-person captain voice: the bullets are the captain's own words about their own work, ready to speak.
- Plain outcome language throughout.
- NEVER any firstmate-internal vocabulary: no crewmate, scout, task ids, briefs, worktrees, watcher, harness names, or delivery-mode labels - describe delegated work as the captain's own ("I shipped X", "I have a fix for Y in review").

## Read-mostly rule

This skill must not mutate fleet state.
No teardown, merge, steer, backlog mutation, or status writes as a side effect; its only write is the standup file itself.
If the state you read suggests an action, name it as a bullet (usually under `## Today` or `## Waiting on`) and let the captain act on it outside this skill.

## Relationship to siblings

`/bearings` is firstmate's operational fleet status report; `/stow` files durable knowledge to disk.
`/standup` only composes the captain's human-facing bullets, and is best run after `/stow` so the session's knowledge is already captured.
