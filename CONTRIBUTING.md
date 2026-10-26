# Contributing to ArnCode

Use Node.js 20.19 or newer, npm, and Bash. Start from a local checkout:

```sh
npm ci
npm run dev -- --help
```

ArnCode grants full tool access by default. Use a disposable project in a VM, container, or sandbox when trying changes; `--safe` enables approval prompts. The README includes a Docker example.

Keep changes focused and modules small. Preserve the shared terminal and permission behavior across API-key and OAuth modes. A new provider request path must use the existing redaction, retry, metering, and credential-selection code.

Before submitting a change, run:

```sh
npm run format
npm run typecheck
npm test
npm run lint
npm run build
```

Add tests for behavior that could silently regress, particularly multi-account rotation, full-access and ask modes, on-demand skill loading, session recovery, streaming, and subprocess cleanup. Use temporary directories and mocked provider responses. Set `ARNCODE_CONFIG_DIR` to a temporary directory outside any repository for CLI tests. Automated tests must not require credentials, contact a paid API, or write to a contributor's real credential bank.

For terminal changes, walk through both an interactive session and piped input. For tool changes, verify the actual filesystem or process result, not just a mocked call. Explain the problem, resulting behavior, and relevant validation in the pull request.

Keep credentials in environment variables or the local credential bank outside the repository. Do not include keys, OAuth tokens, private session logs, or unredacted provider errors in commits or issue reports. Use `arncode creds add` for a hidden prompt. Live smoke tests are optional and can incur provider charges.

Report bugs with your operating system, Node.js version, ArnCode version, invocation, and a minimal reproduction. Remove private project content and credentials before sharing logs. For security-sensitive reports, contact the repository maintainers privately rather than posting exploitable details in a public issue.

Contributions are licensed under the repository's MIT license.
