# pi-config

Configuration for [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent).

## Setup

Clone this repo and symlink to `~/.pi`:

```bash
git clone git@github.com:yourusername/pi-config.git ~/dev/pi-config
ln -s ~/dev/pi-config/agent ~/.pi/agent
```

Or if `~/.pi` already exists:
```bash
rm -rf ~/.pi/agent
ln -s ~/dev/pi-config/agent ~/.pi/agent
```

## Contents

- `agent/settings.json` - Default provider, model, and settings
- `agent/agents/` - Subagent definitions
- `agent/extensions/` - Custom extensions
- `agent/prompts/` - Prompt templates
- `agent/skills/` - Custom skills

## Credentials

API credentials (`auth.json`) are not stored in this repo. Run `pi` and configure your API keys on first use.
