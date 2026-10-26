# Contributing to ArnCode

Use Node.js 20.19 or newer, npm, and Bash. From a local checkout:

```sh
npm ci
npm run dev -- --help
```

ArnCode grants full tool access by default. Try changes in a disposable project inside a VM, container, or sandbox; `--safe` enables approval prompts. See the [Docker example](README.md#run-in-a-container).

## Making a change

Keep changes focused and modules small. Preserve the same terminal and permission behavior across API-key and OAuth modes. Provider request paths should use the existing credential-selection, redaction, retry, and metering modules.

Add tests for behavior that could silently regress: account rotation, full-access and ask modes, on-demand skill loading, session recovery, streaming, or subprocess cleanup. Use temporary directories and mocked provider responses. Set `ARNCODE_CONFIG_DIR` to a temporary directory outside any repository for CLI tests. Automated tests must not need credentials, contact a paid API, or write to a contributor's real credential bank.

For terminal changes, walk through an interactive session and piped input. For tool changes, inspect the actual filesystem or process result. For documentation, check the examples against the implemented commands and verify relative links. Keep badges and documentation links tied to actual packages and workflows.

## Verification

```sh
npm run format
npm run typecheck
npm test
npm run lint
npm run build
```

Describe the problem, resulting behavior, and relevant validation in the pull request. Keep public documentation aligned with the final behavior; avoid claims based only on plans or mocked demonstrations.

## Credentials and bug reports

Keep credentials in environment variables or the local bank outside the repository. Use `arncode creds add` for a hidden prompt. Do not commit keys, OAuth tokens, private session logs, or unredacted provider errors. Live smoke tests are optional and can incur provider charges.

Report bugs with the operating system, Node.js version, ArnCode version, invocation, and a minimal reproduction. Remove private project content and credentials from shared logs. Send security-sensitive details privately to the repository maintainers rather than including them in a public issue.

Contributions are licensed under the repository's [MIT license](LICENSE).
