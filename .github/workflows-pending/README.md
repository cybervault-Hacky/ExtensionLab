# Pending CI workflow

`ci.yml` in this directory is the complete ExtensionLab CI definition
(typecheck, lint, unit/integration tests, build, migrations on a fresh
database, real-Docker E2E with `EXTENSIONLAB_E2E_DOCKER=1`, image builds).

It lives here instead of `.github/workflows/` because the automation that
authored it pushes through a GitHub App without the `workflows` permission,
and GitHub refuses pushes that create or update workflow files in that case.

To activate it, a maintainer with workflow permissions runs:

```bash
git mv .github/workflows-pending/ci.yml .github/workflows/ci.yml
git commit -m "ci: activate workflow"
git push
```

Nothing in the file needs to change.
