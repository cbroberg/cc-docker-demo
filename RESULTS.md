# Test Results — cc-docker-demo v2

**Date:** ___________
**Docker Desktop version:** ___________
**Docker Sandbox version:** ___________
**macOS version:** ___________
**Claude Code version:** ___________

## Mode A: Plain Docker Container

- [ ] Image builds successfully
- [ ] CLAUDE_CODE_OAUTH_TOKEN accepted
- [ ] cc executes prompt without permission prompts
- [ ] cc creates hello.mjs in workspace
- [ ] hello.mjs runs and produces output
- [ ] Files visible on host after container exits
- [ ] Container exits cleanly (code 0)

**Startup time (image exists):** _____ seconds
**Total execution time:** _____ seconds
**Notes:**

---

## Mode B: Docker Sandbox (microVM)

- [ ] `docker sandbox version` works
- [ ] Sandbox creates successfully
- [ ] `-p` headless mode works through sandbox
- [ ] cc authenticates automatically (host proxy)
- [ ] cc executes prompt without permission prompts
- [ ] cc creates hello.mjs in workspace
- [ ] hello.mjs runs and produces output
- [ ] Files visible on host after sandbox completes
- [ ] Process exits cleanly (code 0)
- [ ] Sandbox cleanup works (`docker sandbox rm`)

**Startup time (first run, pulling template):** _____ seconds
**Startup time (subsequent runs):** _____ seconds
**Total execution time:** _____ seconds
**Notes:**

---

## Comparison

| Metric | Mode A | Mode B |
|--------|--------|--------|
| Build/setup time | | |
| Execution time | | |
| Auth complexity | | |
| File sync | | |
| Cleanup | | |

---

## Key Findings

### Does `-p` headless work in Docker Sandbox?
Answer: ___________

### Does host proxy handle Max plan auth automatically?
Answer: ___________

### Startup overhead: microVM vs container?
Answer: ___________

### Any issues with workspace file sync?
Answer: ___________

---

## Implications for CPM v4 Addendum

Based on these results, the following changes to v4-cpm-autonomous-runner-plan-add-1.md are recommended:

1. ___________
2. ___________
3. ___________
