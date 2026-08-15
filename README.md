# dsh-thinking-efforts

Automatically add `off / high / max` reasoning efforts to every model saved under a custom `llm-pi-ai` provider in DeepSeek Harness (DSH).

## Behavior

- Listens to the `settings/updated` event for the `llm-pi-ai` namespace.
- For every provider model or `modelOverrides` entry without an explicit `reasoningEfforts`, writes:

```yaml
reasoningEfforts:
  off: null
  high: high
  max: max
```

- Existing explicit `reasoningEfforts` (including `false`) is never overwritten.
- The plugin also scans the current `llm-pi-ai` config shortly after startup.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Set `false` to disable auto application. |
| `force` | `false` | Set `true` to overwrite explicit user declarations. |

## Install

```powershell
cd dsh-thinking-efforts
dsh plugin --profile web add .
```

Restart `dsh web` and hard-refresh the browser after installing.

## Test

```powershell
npm test
```

## License

MIT
