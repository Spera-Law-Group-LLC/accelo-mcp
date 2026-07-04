# Deploy / update runbook (accelo-mcp)

How to safely ship a new build of `accelo-mcp` to the Hetzner host so that the
running container actually serves the new code.

> **Why this file exists (#29).** A deploy once shipped the **old** tool set even
> though the build "succeeded" and `/healthz` was green. Root-cause chain:
> 1. `/opt/accelo-mcp` (including `.git`) is owned by **`deploy:deploy`**. The
>    SSH/ops session that ran the documented `git pull` was **not** the `deploy`
>    user.
> 2. `git fetch` failed with `cannot open '.git/FETCH_HEAD': Permission denied`
>    for the non-`deploy` user, so the pull **silently no-op'd** and left the
>    checkout several commits behind.
> 3. `docker compose up -d --build` then dutifully rebuilt from the **unchanged**
>    source, came up healthy, and `/healthz` returned ok — so nothing looked
>    wrong, but the new tools were never in the image.
>
> **A `git pull` that fails on a permission error still exits the session
> "looking" done. `up -d --build` reports success from cache regardless of
> whether `src/` changed. Container `Up` + `/healthz` ok do NOT prove fresh
> code.** The steps below make a stale build fail loudly instead.

---

## 0. Prerequisites — run as the `deploy` user

The repo checkout at `/opt/accelo-mcp` is owned by **`deploy:deploy`**. The `mcp`
SSH user **cannot** advance `.git` (that is by design — see librechat-infra #67).
Every `git` and `docker compose` command below MUST run as `deploy`:

```bash
sudo -u deploy -i          # become deploy (login shell) BEFORE anything else
cd /opt/accelo-mcp
```

Confirm you are actually `deploy` and own the tree before continuing:

```bash
id -un                     # -> deploy
stat -c '%U' .git          # -> deploy
```

If either is not `deploy`, STOP — running the rest as another user is exactly
what caused #29.

---

## 1. Fetch + fast-forward ONLY (never a bare `pull`)

Use `--ff-only` so a non-fast-forward **or an auth/permission failure errors
loudly** instead of silently no-op'ing:

```bash
git fetch origin
git merge --ff-only origin/main
```

If this errors (permission, diverged history, etc.) — **do not proceed to build.**
Resolve it first. A failed fetch here is the whole bug class #29 is about.

---

## 2. Pre-build assertion — the intended code is on disk

Eyeball HEAD against the commit you intend to ship, and assert that a symbol
unique to this change is present in the source **before** building. Pick a
symbol that only exists in the new code (a new tool name, function, string):

```bash
git rev-parse HEAD                       # compare against the intended commit SHA
git --no-pager log --oneline -1          # sanity: is this the change you expect?

# Example: shipping a new `list_issues` tool — abort if it isn't on disk yet:
grep -q "list_issues" src/issues.js || { echo "STALE SOURCE — aborting"; exit 1; }
```

If the `grep` fails, the checkout is stale — go back to Step 1. Do **not** build.

---

## 3. Build + restart

```bash
docker compose up -d --build
```

---

## 4. Post-build assertion — the new code is in the IMAGE

`up -d --build` can report success from cached layers, so verify the symbol is
baked into the **running image**, not just present on the host disk:

```bash
# Must print a non-zero count. 0 => the image is stale despite a "successful" build.
docker compose exec accelo-mcp grep -c "list_issues" /app/src/issues.js

# Health is necessary but NOT sufficient — check it, but never treat it as proof
# of fresh code:
curl -s http://127.0.0.1:8787/healthz
```

If the in-image `grep` count is 0, the container is running stale code even
though it is `Up` and healthy. Rebuild without cache and re-assert:

```bash
docker compose build --no-cache accelo-mcp && docker compose up -d
docker compose exec accelo-mcp grep -c "list_issues" /app/src/issues.js
```

---

## Acceptance (every deploy)

- [ ] All `git` / `docker compose` commands ran as the **`deploy`** user.
- [ ] Updated via `git merge --ff-only origin/main` (a failed fetch errored, did not no-op).
- [ ] **Pre-build** assertion passed: HEAD is the intended SHA and the new symbol is on disk.
- [ ] **Post-build** assertion passed: the new symbol is present **inside the running image**.
- [ ] Confirmed that container `Up` + `/healthz` ok were **not** treated as proof of fresh code.

---

## Sibling MCP repos

The same `deploy:deploy`-owned checkout layout applies to the firm's other
internal MCP servers (e.g. `docx-redline-mcp`, and any MCP deployed under
`/opt/<name>` with a `deploy`-owned `.git`). Apply this identical run-as-`deploy`
+ `--ff-only` + pre/post-build-assertion procedure there too — pick a
change-unique symbol appropriate to that repo's source layout for Steps 2 and 4.
