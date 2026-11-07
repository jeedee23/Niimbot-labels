# COPILOT_READ_FIRST

Instructions for any AI assistant (GitHub Copilot, Copilot CLI, or similar)
working in this repository. The owner is @jeedee23. Read this before starting
work.

## 1. Register this chat so it can never be lost

VS Code binds each chat to the exact workspace identity (single folder,
multi-root workspace, or empty window) that was open when the chat started.
Switching or adding folders hides the chat. Therefore, at the **start of any
substantial chat session**, and again **whenever the workspace changes**:

1. Create or update `chatlink.md` in the repository root.
2. Add/refresh a row in the registry table (format below) with:
   - **Machine**: the hostname where the chat runs (`$env:COMPUTERNAME` /
     `hostname`).
   - **Session ID**: the assistant's own session ID.
   - **Chat title**: the current chat title.
   - **Workspace to reopen**: the exact folder or `.code-workspace` path that
     was open when the chat was created (this is what must be reopened to see
     the chat in the sessions list).
   - **CLI resume**: `copilot --resume <session-id>` (works from any
     workspace **on that machine**).
   - **Date**: creation date of the chat.
3. Commit and push the update (do not block work if push fails; retry at the
   end of the session).

### Registry format for `chatlink.md`

| Date | Machine | Chat title | Session ID | Workspace to reopen | CLI resume |
|---|---|---|---|---|---|
| 2026-11-07 | RYZEN9_WIN11_MI | Windows workstation setup folder in repo | `56f746f2-042b-4b87-981e-32dcfd6a82d9` | `C:\Users\johan\source\repos\ubuntu-workstation-setup` (plain folder) | `copilot --resume 56f746f2-042b-4b87-981e-32dcfd6a82d9` |

Chats are stored **per machine**. The Machine column tells the owner where to
go (or which machine to connect to) to resume a chat.

## 2. Owner conventions (apply in every repo)

- **Check before installing**: never reinstall software that is already
  installed.
- **App catalogs are the source of truth**: install only entries whose
  `install` value is the JSON boolean `true` in the repo's `apps.json`
  (see `appinstaller.md` where present).
- **No destructive or exposing changes** without explicit approval: nothing
  disk-, boot-, authentication-, service-enabling-, or
  network-exposure-related.
- **Detect the machine first** (read-only) before machine-dependent work.
- **Commit style**: include the Copilot co-author trailer; push after
  committing so work is never only local.

## 3. Multi-machine / central server notes (for the owner)

- Chats live on the machine where they were created. `chat.sessionSync`
  (Settings Sync) copies chat *history* between machines signed into the same
  account, but the live/resumable session stays on its machine.
- **Central chat server option**: dedicate a machine (e.g., a mini PC), run
  `code tunnel` (VS Code Remote Tunnels) or SSH on it, and always start chats
  while connected to it (from any laptop/desktop or vscode.dev). All sessions
  then live centrally on that one machine and are resumable from anywhere.
  Caveat: the AI then *executes* on the server, so machine-specific setup of
  other PCs still requires a local chat on that PC.
- Cloud sessions (github.com/copilot) are centralized by design but cannot
  touch any local machine; use them only for pure repository work.
