# Hivemind local fork

This is the Hivemind maintained copy of [0xcaff/codex-web](https://github.com/0xcaff/codex-web).
It was copied from upstream commit `2424e8548db3eebeb49eef5057ef750688bb680b`.

The initial fork also carries the local workspace picker changes that were
present in the installed Codex Web checkout when it was copied. Keep upstream
application bundles and runtime state out of this directory's Git history.

## Local patch

`patches/webview-archive-empty-thread.patch` handles archiving a truly empty
conversation when the app-server reports that it has no rollout. Codex Web has
no desktop inactive-thread archive service, so the upstream fallback rejected
this case. The patch only treats conversations with zero messages as archived;
conversations with content continue through the normal error path.

The patch is applied by `scripts/prepare_asar`. `scratch/`, `node_modules/`, and
compiled server output are local build/runtime artifacts and must not be
committed.

## Browser file access

`patches/app-host-browser-files.patch` routes local openIn actions and config.toml
opening to the requesting browser view. Source and operational details are in
[the local project docs](docs/README.md) and [file access guide](docs/file-access.md).
