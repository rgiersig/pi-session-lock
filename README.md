# pi-session-lock

A **Linux-only advisory session lock** for the [Pi coding agent](https://github.com/earendil-works/pi). Avoid accidentally resuming the same JSONL session in two terminal processes or a terminal and a WebUI tab.

Tested with Pi 1.0.4 and Node 22. Terminal, RPC and a separate Pi WebUI instance were tested, including browser confirmation of conflict warnings and blocked input.

## Try or install

Clone this repository, then:

```sh
# Try for one process
pi -e ./index.ts

# Or install the package from this directory for all new sessions
pi install /absolute/path/to/pi-session-lock
```

Run `/reload` in existing terminal and WebUI sessions after installation. All participating processes must load this extension; processes without it are invisible. Do not load a copied local version and this package simultaneously.

## Behavior

- Claims a session lock at startup, before ordinary input, and after session replacement.
- Cancels `/resume` when another live process owns the destination.
- Warns and blocks ordinary prompt input and user bash commands in a conflicted session.
- Cancels manual compaction and tree navigation when conflicted.
- Keeps the same ownership across `/reload`.
- Releases the old session lock after switching, creating a new session, or forking.
- Automatically reclaims a demonstrably dead owner, but never overrides a live or ambiguous owner.

Commands:

- `/session-lock`: check and report the current lock.
- `/session-lock-override`: retry stale-owner recovery; **not** a force takeover of a live process.

Switch to another session or fork to continue independently.

## Important limits

**This is not a hard write lock or a security boundary.** Pi can read, migrate, or write model/thinking metadata before extension startup. Some RPC metadata operations and third-party extension commands bypass the input hook. Automatic continuations and all possible JSONL writes are not comprehensively protected. A core `SessionManager` lock is needed for a pre-load, all-writers guarantee.

Use this to prevent normal accidental concurrent conversation work, not as a promise of zero writes by a refused process.

## Storage and recovery

Locks live in `<agent-directory>/session-locks/<SHA-256-of-canonical-session-path>.lock/owner.json`. The agent directory is `PI_CODING_AGENT_DIR` if set, otherwise `~/.pi/agent`. Lock directories use mode `0700` and owner files `0600`. Session content and credentials are never copied into locks.

Ownership records contain a random process identity, PID, hostname, Linux boot ID, process start ticks, canonical session path and acquisition timestamp. PID reuse is detected. A `globalThis` symbol preserves the identity across extension reload without passing it to child processes.

Locks deliberately remain after quit and are reclaimed after proving the recorded process is dead. A missing/malformed owner record, remote hostname, unreadable process information or abandoned reclaim guard fails closed. If necessary, inspect the exact session lock, verify that no process uses that session, and remove only its lock and reclaim guard. Never delete all locks while Pi processes are running.

Only local Linux filesystem use is supported. Cross-host shared sessions and network-filesystem coordination are not supported.

## Development

No runtime dependencies or build step are required; Pi loads TypeScript through its extension loader.

```sh
npm test                  # six primitive test cases
npm run test:integration  # real isolated RPC and TUI processes
npm run test:webui        # optional installed-WebUI HTTP/SSE test
npm run test:all           # eight base cases + optional WebUI case
```

Integration tests require `pi` on PATH and `tmux`; set `PI_TEST_BIN` to use another Pi executable. They use temporary agent directories and sessions, do not call a provider, and do not touch running WebUI services.

The optional WebUI test runs only if `@firstpick/pi-package-webui` can be resolved, `pi-webui` is on PATH, or the conventional `~/.local/share/pi-webui` installation exists. Otherwise Node reports **SKIP**, not a failure. For a custom installation, set `PI_TEST_WEBUI_BIN` to the executable or `bin/pi-webui.mjs` path. An explicit invalid path fails instead of silently skipping. Set `PI_TEST_WEBUI=0` to skip it even when installed.

It starts a separate loopback-only WebUI on a temporary free port, with a temporary agent directory and a dedicated owner process. HTTP responses must report handled prompts; SSE must deliver the conflict and blocked-input warnings; no JSONL may be created. Its processes and temporary files are removed automatically. An installed but incompatible/broken WebUI fails the test. Nothing is installed or updated by the test. Browser visual acceptance was performed separately; this automated test verifies transport and behavior, not rendering.

## Prior art

Related upstream issues: [#8300](https://github.com/earendil-works/pi/issues/8300), [#8848](https://github.com/earendil-works/pi/issues/8848), [#9596](https://github.com/earendil-works/pi/issues/9596). Their automated closure does not indicate a fix.

A [comment on #8300](https://github.com/earendil-works/pi/issues/8300#issuecomment-6019683668) describes another local `flock` extension without a linked source package, and identifies the same pre-hook limitation. GitHub research found no directly reusable published equivalent; this is not a claim that none exists. The similarly named `pi-session-guard` package manages disk quotas and cleanup, not concurrent session ownership.

## License and provenance

MIT. Developed for Roland Giersig with AI coding assistance. The implementation and tests were exercised locally; review the source and limitations before enabling it.
