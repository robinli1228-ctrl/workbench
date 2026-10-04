# Contributing

Thanks for helping improve the workbench. Please read `docs/OPERATING-GUIDE.md` first; it explains what is public, how to run single-node and multi-server setups, and the pre-publish checklist.

## Ground rules

- Never commit real account, login, token, server address or personal path information. Use `xxxxx` as the placeholder in docs, examples and tests.
- Never commit data directories (`.data/`, `.local/`, `.workbench/`), `.env` files, `outputs/` or `reviews/`.
- Keep changes focused. One topic per pull request.

## Workflow

1. Fork the repository and create a branch from `main`.
2. Make your change and run `npm run check` (Node >= 22.16).
3. Open a pull request describing what changed and why.

## Reporting issues

Describe your setup (single node or multiple devices, which CLIs), what you expected, what happened, and relevant logs with secrets and addresses replaced by `xxxxx`.
