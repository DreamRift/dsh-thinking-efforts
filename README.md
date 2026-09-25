# dsh-thinking-efforts

Automatically add `off / low / high / max` reasoning efforts to every model saved under a custom `llm-pi-ai` provider in DeepSeek Harness (DSH), so the Composer model selector shows the thinking-intensity options for custom providers just like official ones.

## Behavior

- Listens to the `settings/document-updated` event for the `llm-pi-ai` namespace (DSH 0.1.7-rc.x; the older `settings/updated` event no longer exists in current DSH builds).
- Reads the current configuration through `settings.describe()` and scans the namespace's **user layer** (`user.providers`, the profile patch layer where your custom providers live). Bundle-inherited providers are never touched.
- For every provider model or `modelOverrides` entry without an explicit `reasoningEfforts`, writes:

```yaml
reasoningEfforts:
  off: null
  low: low      # ← added in v0.2.0
  high: high
  max: max
```

- Existing explicit `reasoningEfforts` (including 3-tier `{ off, high, max }` or `false`) is never overwritten unless `force: true`.
- Also sweeps shortly after startup and retries while the `llm-pi-ai` settings namespace is still activating, plus on every `app-boot/config-reload` / `llm/adapters-updated` as fallback triggers.
- Writes go through `settings.mutate('llm-pi-ai', ops)`. `providers` is a volatile field of `llm-pi-ai`, so the commit is hot — the entry does not restart and the Composer picks the new levels up immediately.
- The write lands in the active profile's `cordis.patch.yml`, so it survives restarts.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Set `false` to disable auto application. |
| `force` | `false` | Set `true` to overwrite explicit user declarations (entries already equal to the target four tiers are skipped, so writes always converge). |

## Install

```powershell
# from a release tarball (see the Releases page below)
dsh plugin --profile desktop add <path>\dsh-thinking-efforts-0.3.0.tgz

# or straight from the repository
dsh plugin --profile desktop add git+https://github.com/DreamRift/dsh-thinking-efforts.git
```

Prebuilt tarballs are attached to each GitHub Release:
<https://github.com/DreamRift/dsh-thinking-efforts/releases>

Restart DSH and hard-refresh the browser after installing. The desktop profile wires the plugin's `cordis.patch.yml` in as a bundle overlay automatically (via `dsh.bundle.patch`).

## Test

```powershell
npm test
```

## Changelog

### v0.3.0 (2026-08-20)

- **Fix: plugin had no effect on current DSH.** Adapted to DSH 0.1.7-rc.x (official desktop nightly):
  - Trigger event corrected from the removed `settings/updated` to `settings/document-updated(ns, revision)`.
  - Current values are now read from `settings.describe()` user layer; the old `ctx.settings.get(ns)` call path no longer exists in this DSH version (the settings service only offers `describe`/`update`/`replace`/`mutate`/`configure`/`prepareDocument`).
  - Startup sweep now retries until the `llm-pi-ai` settings namespace is active, and falls back to `app-boot/config-reload` / `llm/adapters-updated` triggers.
  - `force: true` now skips entries already equal to the target tiers, so the verification sweep always converges (no write loop).
- Added a `dispose()` teardown that clears pending timers.

### v0.2.0 (2026-08-20)

- **BREAKING**: Default reasoning tiers upgraded from 3 (`off/high/max`) to 4 (`off/low/high/max`), aligning with the official `llm-deepseek` adapter since rc.7.
- Models with existing `reasoningEfforts` are no longer overwritten (default `force: false`).
- Use `force: true` to forcibly update all models.

### v0.1.0 (Initial Release)

- Auto-add `off/high/max` reasoning efforts to custom provider models.
- Respect explicit declarations (do not overwrite when present).

## License

MIT
