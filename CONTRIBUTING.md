# Contributing

Thank you for contributing.

## Development setup

```bash
npm install
npm run check
```

Keep changes focused and include tests for public behavior. Public APIs must be reachable through a
declared package export; do not ask consumers to import internal source paths.

A change to the driven ports affects every transport a host may implement. Extend them only when the
behavior belongs to the intersection of what every transport can do, or when a transport performs
the operation better than a caller driving it from outside; anything else belongs in the application
layer, where it is written once and behaves the same everywhere.

Claims about platform audio behavior must arrive with the measurement that produced them: the
device, the date, and the figure. This repository documents rules that cost time to establish, and a
rule without its measurement is reverted by the next reader who has a plausible reason.

All Markdown documentation must be written in English. Keep architecture and lifecycle diagrams in
Mermaid so they render directly on GitHub. Do not add migration logs, product history, or references
to private or product-specific repositories: the only application this repository names is its own
sample. Run `npm run check:docs` after documentation changes.

Source code, comments and test names are written in English, use two-space indentation, and name a
class module after the class it exports.

Never commit credentials, personal email addresses, local home-directory paths, project
configuration, signing material, or consumer-specific secret names. Keep those values in the host
application or its protected CI environment and run `npm run check:sensitive` before committing.
Source code and comments must not contain developer identities or personal data. There are no
personal allowlists: email scanning includes the checker itself. Git author metadata is separate
from tracked content and does not require an identity-specific exception in source code.

## Pull requests

Describe the problem, the chosen behavior and the verification performed. Keep unrelated cleanup in
separate changes. By contributing, you agree that your contribution is licensed under the MIT
License included with this repository.

Pull requests do not run workflows in this repository. Contributors must run `npm run check`
locally or in their own fork and report the result in the pull request. The repository owner runs
the `Validate` workflow manually after reviewing the contribution; commits and pushes never start
it. Pushes to `main` also never deploy GitHub Pages. The tagged `Deploy` workflow publishes the
sample only after creating a successful GitHub Release. See the
[release guide](docs/RELEASING.md) for the release and deployment procedure.
