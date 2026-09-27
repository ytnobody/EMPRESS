# Release Procedure (develop → main → GitHub Release)

This documents the **manual** procedure for cutting a release of EMPRESS:

1. merge the development branch `develop` into the stable branch `main`, and
2. release that `main` as a git tag + GitHub Release.

This flow is intentionally **not automated** — an operator runs the git/`gh`
commands below by hand. There is no release script to run.

## Why a release means a `develop → main` merge first

`main` is the stable tip that releases are cut from. `develop` accumulates work
that is not yet released. Because `main` is typically older than `develop`, the
release merge is a **forward merge** of `develop` into `main`. The steps below
keep that merge on GitHub (a pull request) so the history is preserved, then
tag and release the merged `main`.

Check the two branches against each other first. Everything below assumes the
local repositories are up to date:

```sh
git fetch origin
git log --oneline origin/main..origin/develop   # commits you're about to release
```

There should be **no tags** `vX.Y.Z` yet on `origin` for the version you're
cutting (EMPRESS is at `0.1.0`). Verify with:

```sh
git ls-remote --tags origin
```

> The version stays `0.1.0` in `package.json`  — a release does **not** bump
> it. Only change it when you genuinely want a new product version.

## Step 1 — merge `develop` into `main` via a pull request

Use GitHub (via the `gh` CLI) so the merge is reviewable and its history
remains. `main` must already be up to date:

```sh
git fetch origin
git checkout main && git pull origin main
```

Open a `develop → main` pull request:

```sh
gh pr create \
  --base main --head develop \
  --title "Release: merge develop into main" \
  --body "Forward merge of develop into main for the v0.1.0 release."
```

Review, then **merge it on GitHub** (a "merge commit" / default merge, not a
squash, to keep the develop history intact):

```sh
gh pr merge <PR-NUMBER> --merge --delete-branch=false
```

> `--delete-branch=false` because we keep `develop` alive (it is not a
> feature branch — it's the ongoing development branch).

Update the local `main` so it matches the merged remote tip:

```sh
git fetch origin
git checkout main && git pull origin main
```

**Verify** the merge: `main` now equals the head of `develop`:

```sh
git rev-parse origin/main origin/develop   # should print the same commit twice
git diff --stat origin/main origin/develop # empty
```

## Step 2 — tag `main` and push the tag

Tag the merged `main` at the version in `package.json` (currently `0.1.0`):

```sh
git tag v0.1.0 origin/main
git push origin v0.1.0
```

**Verify** the tag is on the remote:

```sh
git ls-remote --tags origin          # v0.1.0 present
git rev-parse tags/v0.1.0            # matches origin/main's commit
```

## Step 3 — create the GitHub Release

Create the release with release notes pointing at the pushed tag. If you have a
`RELEASE_NOTES.md` or `CHANGELOG`, pass it with `--notes-file`; otherwise pass
inline notes:

```sh
gh release create v0.1.0 \
  --title "v0.1.0" \
  --notes "First EMPRESS release — see the README and docs/ for what it does."
```

**Verify** the release exists:

```sh
gh release view v0.1.0
```

## Done — what "released" means, and what it doesn't

Acceptance for a release is:

- [ ] a `develop → main` PR was created and merged on GitHub, and `main` equals
      `develop` (`git rev-parse origin/main origin/develop` match)
- [ ] tag `v0.1.0` exists on `origin` (`git ls-remote --tags origin`)
- [ ] a GitHub Release exists (`gh release view v0.1.0`)

A release does **not** (Non-Goals):

- publish to the npm registry
- bump `package.json`'s `version` (it stays `0.1.0`)
- auto-generate a CHANGELOG
- schedule or automate re-releases