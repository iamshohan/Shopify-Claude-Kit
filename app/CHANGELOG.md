# Changelog

## 0.2.0 — 2026-11-24

After the first real run (an extension-only A/B app: setup, onboard and a first change took about 25 dev interactions, and left 19 kit notes).

- **Setup asks what kind of app first.** An untouched app template that should be extension-only gets re-initialised with the extension-only option before onboarding: onboarding the template recorded 43 surfaces, and removing them took a full change with two gates. Aim: setup and onboard take at most three things from the dev.
- **A lone `shopify.app.toml` is treated as production.** The dev creates a dev app first (`config link`, "Create a new app"), and setup copies the production toml's sections into the new, nearly empty dev toml itself (keeping its client_id, name and handle), shows the diff and validates it.
- **Branch protection that can't be checked** (no `gh`) is a ✗ under "Needs you", with where to set it. In the first run, a direct push to main went through.
- **`app.mjs onboard --redo`** rewrites the baseline while `appspec/` isn't committed; the guard kept the agent from deleting those files, so the dev had to. Onboard prints the merge link, and **`app.mjs start` refuses until the onboarding is merged into the base branch**: changes measured their surfaces against a base without it.
- **Propose validates an edited app or extension toml** with `shopify.mjs validate` before Gate 1: dropping `[auth]` from a docs reading cost a second Gate 1.
- **A kit update no longer fails a change in flight:** `gate` asks for § Decided for you only when the proposal has that heading.
- **Run rules:** files are written with the Write or Edit tool (a `package.json` with a deploy script or a `.gitignore` listing `.env`, written through the shell, read as commands to the guard), and each kit note is one direct `app.mjs note` call.
- **Guard:** reading the installed CLI's source (`cd` into its folder, then grep) is allowed when every part of the command only reads; running anything from there is still refused.
- **The deploy checklist follows what the change did.** A change that removed the backend no longer gets "migrate the production database" and "deploy the app server": it gets "retire the hosting and the database after the release". The checklist starts with validating the production config (the kit validates only the dev app's).
- **The app type is read from the repo, not only from setup:** status says when `kind` in app-kit.json no longer matches (setup's "admin" stayed after the backend was removed).
- **`app dev` runs in a separate terminal:** `shopify.mjs info` prints the appDev command without `!` and says where to run it. With `!` the dev server held the Claude Code session.
- **A refused chained command:** the rules say to run its parts on their own before blaming the guard. Three of the run's "false positives" came from another part of the same command.
- **Handoff keeps `appspec/project.md` true** when a change adds or removes what it describes. The README says the commands are typed, not pasted.

## 0.1.0 (not trialled on a real app change)

The Shopify App Kit: Claude Code for Shopify apps (admin apps and extension-only apps), scenarios first. It lives in `app/` of the Shopify-Claude-Kit repo; devs install it with `node install.mjs <app-repo> --app` from that repo's root.

- **Fewer questions** (with theme kit 1.15.0): the agent decides what the ticket, the app's code, the archived changes or the docs answer, and lists those decisions in proposal.md § Decided for you, which Gate 1 shows and `gate` wants filled (or "none"). It asks only for a departure from the ticket, a new scope or something the merchant maintains, money, real alternatives, a contradiction, or something hard to undo. It also picks a change's ID itself, reuses the change's own branch, and checks whether `app dev` reloaded instead of asking.
- **`/app-ab` writes the A/B test's own code** (from the team's abtest-checkout-extension skill), kept in the app repo under `abtest/<ID>/` instead of shadow-drip-experiments: `variation.js` sets the gate, `control.js` removes it. They start from two new templates (`kit/templates/abtest-variation.js`, `abtest-control.js`). Propose chooses the carrier (cart attribute or line item property) from what the test changes and lists the code in § Tasks. Verify checks the code on the dev store before the checkout rows: values in `/cart.js`, nothing on an empty cart, no second update, no loop on drawer changes, other attributes kept, control clears them. Extension names never carry the ticket key. Existing test code put in `abtest/<ID>/` stays data.

- **Guard** (with theme kit 1.13.10): text read from a file (`git commit -F`, `gh pr create --body-file`) is scanned for secrets; `gh auth token`, `git credential fill` and `~/.git-credentials` are refused; `gh api` writes to `…/contents/`, `gh repo sync`, `git subtree push` and `send-pack` are refused; `git push -q` is allowed; the Shopify plugin's `search_docs` runs whatever its query says; edits to `core.mjs` and `repo.mjs` ask. New self-tests for the SQLite, fetcher, access-token and `create-app` rules.
- **Playwright's output stays out of git** (with theme kit 1.13.8): the installer adds `.playwright-mcp/` to `.git/info/exclude`, and setup reports a repo that already tracks it.
- **One Jira token file per machine** (with theme kit 1.13.7): setup, the README and `jira.mjs` point to `~/.claude/.env` (once per machine) instead of a `.claude/.env.local` in every repo. The per-repo file still wins, for a repo that needs another Jira account; `JIRA_BASE_URL` stays out of the global file.
- **Shared with theme kit 1.13.1:** the guard checks `findstr /s` globs that reach `.env` files, and no longer blocks `Get-ChildItem env:PATH` or `cat .eslintrc*`. A moved kit clone shows a notice instead of silently ending update notices. On Windows, one repo spelled several ways is one entry in `update.mjs`'s list.
- **The repo moved** (2026-11-17) from `DripDevelopment/Shopify-Claude-Kit` to `github.com/iamshohan/Shopify-Claude-Kit`. A clone of the old repo gets no more updates: run `git remote set-url origin https://github.com/iamshohan/Shopify-Claude-Kit.git` in it.
- **A blocked permission mode names the modes that work** (with theme kit 1.11.3): Shift+Tab to auto (recommended), default or accept edits.
- **Updates** (with theme kit 1.2.0): `node update.mjs` from the kit repo updates every app and theme repo on the machine, and a SessionStart hook (`kit/update-check.mjs`) mentions a newer kit once every 15 days. The installer lists the repo for `update.mjs` and records its clone in the manifest.
- **`app dev` names its app and store** (with theme kit 1.5.0). A bare `shopify app dev` uses the CLI's cached config and store, possibly the production app or another project's store. `shopify.mjs info` now gives the exact command (`appDev`, with `--config` and `--store`), warns when the CLI caches another dev store, and verify tells the dev to run that command.
- **Gate 1 hands the proposal over** instead of asking: the dev reviews and replies in their own words.
- **A fix proves its reproduction** (with theme kit 1.6.0): `gate` and `done propose` run a fix's bound tests on the unfixed code and need at least one to fail on its own (not a missing vitest or file). Otherwise verify's PASS would prove nothing.
- **Fixes** (with theme kit 1.8.0): the fix reproduction check runs only before the first Gate 1, so a fix sent back to propose after it was built can pass again; a Function fixture failing on its missing baseline doesn't count as a reproduction. The run rules no longer say Gate 1 is an AskUserQuestion. The guard's messages no longer name the removed `set` verb or a bare `shopify app dev`; `info` calls the CLI's cached store `cliCachedStore`. Setup asks whether a single `shopify.app.toml` is a development app.
- **A maintenance change needs a test run:** verify fails `regression` when no scenario, ledgered or verify-command test ran.
- **Smaller:** propose says what to do without vitest, declares an extension's real targets rather than the template's, and build commits the generated extension instead of asking about it.
- **Updates** of a repo first installed with `--force` no longer fail. **Cleanup:** removed the unused `secret`/`secretSource`/`parseEnv`, `diagnosticJson`, `activeChanges` and the unused `set` verb.

- **One flow for every change type** (change, fix, maintain, ab): propose → Gate 1 → build → verify → accept (Gate 2) → handoff.
  - `/app-change` starts it; `/app-fix`, `/app-maintain` and `/app-ab` are short entry points to the same flow.
  - `/app-ask` and `/app-drift` are read-only.
- **The proposal** holds:
  - concrete GIVEN/WHEN/THEN scenarios, each bound to a check: a vitest test, a QA measurement on the dev store, or a manual check;
  - the surfaces the change adds;
  - a design section for data models, webhooks, extensions, the app proxy and config;
  - the tasks.

  `app.mjs gate` lists the proposal's problems, then Gate 1 asks everything in one question. Scenario, surface or retired-test changes after Gate 1 are listed at Gate 2. A new extension is generated by the dev first (`! shopify app generate extension`).
- **Verify** checks:
  - **Surfaces:** declared against what the branch changed. A new extension's own API version and dependencies come with it. A surface changed on the base branch outside the kit only warns, and archive records it.
  - **Scenario tests:** each must be new or changed on the branch, or its fixture.
  - **The test ledger,** read from `appspec/archive/`: every archived bound test must still exist and pass, unless a change retires it.
  - **The repo's own checks:**
    - its verify commands;
    - Function fixtures (compared regardless of key order, with the toml's export) and instruction counts;
    - checkout UI bundle size.

    `app build` never installs dependencies or runs a `shopify.web.toml` build that deploys. Extensions are found through `extension_directories`.
  - **`shopify app security check`,** against a findings baseline:
    - New medium, high or unknown-severity findings fail.
    - A check that can't run warns.
    - With no baseline yet, findings in untouched files count as older, and a medium one in a touched file warns.

  QA, results and the code and security reviews are recorded against the app code, so docs, CI or `.gitignore` commits and build output don't make them stale.
- **Handoff** moves the change to `appspec/archive/` and updates `surfaces.json` (one item per line) and the baseline. It writes `handoff.md`: the PR text with QA as measured and the reviews, and a deploy checklist:
  - migration order;
  - hosting, only when the server changed;
  - protected customer data access;
  - deploy with `--config`, and scopes;
  - Function activation and block placement, only for new extensions or targets.

  Re-running a failed handoff is safe.
- **Setup:** `/app-setup` checks the CLI and GitHub branch protection, writes `.claude/app-kit.json`, and creates the Shopify plugin's telemetry opt-out (`app.mjs optout`). `/app-onboard` creates `appspec/` with the current surfaces and the security baseline.
- **Build id:** VERSION plus the installed commit (`-dirty` for an uncommitted checkout), so `cli-check` re-runs after every kit update and feedback names the build.
- **The guard: trust first.** It catches a well-meaning agent's mistakes, not an agent disguising a command on purpose.
  - **Asks** (hard to undo):
    - store mutations, sealed and only on the dev store
    - database migrations
    - the kit's settings
    - writing, moving or removing `.claude/settings*.json`, `~/.claude/settings*.json`, hooks, `.mcp.json` or `.git/`
    - removing or renaming a whole change folder
    - git commands that discard work, and a commit or merge when the branch can't be read
    - a workflow or git hook that deploys, migrates or pushes a protected branch
  - **Refused, with what to do instead:**
    - **CLI and deploys:**
      - the Shopify CLI outside `shopify.mjs`
      - deploy, release, `app env`, `dev clean`, `--store` and `prisma migrate deploy`, including through package scripts in the package a command runs in
    - **Pushes and merges:** pushes other than `git push -u origin <branch>`, tag pushes, merges, a pull of another branch onto main, workflows and releases.
    - **Secrets and databases:**
      - `.env*`, SQLite files and the CLI's login folders
      - printing the environment or one secret by name
      - the Session table (including `db.session`) and `prisma studio`
      - recursive searches over the repo root or `.claude/`
    - **App code:** code edits while a change is at another stage than build.
    - **Kit-written files:** `appspec/archive/` (and deleting it), `surfaces.json`, `security-baseline.json`, and each change's `change.json` and `handoff.md`.
    - **Store writes:** a `mutate` file outside `.claude/logs/<ID>/`, refused before the prompt.
  - **Allowed and logged** (`app.mjs retro`):
    - gate answers and waivers
    - new dependencies
    - CI and hook edits that don't deploy
    - written scripts that call the CLI
    - code edits with no change open
  - **Not refused:** reading or copying kit files, `.env` hygiene, searches for `dotenv` or deploy words, a heredoc of notes, `npm ls`/`view`.
  - **Shared with the theme kit:** the shell reader, push routing and secret rules (`kit/guard-core.mjs`, generated from `shared/`).
  - **Settings:** CLI analytics are off, there's a 10-minute default Bash timeout, and `shopify.mjs --help` is allowed.
- **Jira:** tickets come through the kit's own `kit/jira.mjs` (shared with the theme kit). `/app-setup` asks for `jiraBaseUrl` and checks the credentials in `.claude/.env.local`.
- **Installer:**
  - It ships what git has.
  - It refuses the theme kit's repos and the kit's own repo, and refuses a downgrade or an older build without `--force`.
  - It removes only kit files inside `.claude/`, and doesn't carry a repo's `disableAllHooks` over.
- **Trial so far:** read-only on throwaway clones of BOD-DRIP and asmc-cms with the real CLI 4.9.4 (detect, onboard, drift, the guard on their package scripts, `info`, `security`). The TOML reader matches the CLI's own parse on 11 real config files.
