---
name: install-skill
description: >
  When a user requests to install a new skill, this skill guides you to identify
  the package name from various input formats and use the install_skill MCP tool.
  Supports skills.sh URLs, GitHub URLs, owner/repo, and owner/repo@skill formats.
user-invocable: false
---

# Skill Installation Guide

When a user asks to install a skill (e.g., sends a link, mentions a skill name, or says "install xxx skill"), follow this process:

## 1. Identify the Package Name

Parse the user's input to extract the `owner/repo` or `owner/repo@skill` format:

| Input Format | Example | Extract As |
|---|---|---|
| skills.sh URL | `https://skills.sh/s/owner/repo` | `owner/repo` |
| skills.sh skill URL | `https://skills.sh/s/owner/repo/skill-name` | `owner/repo@skill-name` |
| GitHub URL | `https://github.com/owner/repo` | `owner/repo` |
| GitHub tree URL | `https://github.com/owner/repo/tree/main/skills/name` | `owner/repo@name` |
| Direct package | `owner/repo` | `owner/repo` |
| Package with skill | `owner/repo@skill` | `owner/repo@skill` |

## 2. Install the Skill

Call the `install_skill` MCP tool with the extracted package name:

```
install_skill({ "package": "owner/repo" })
```

Or with a specific skill from the repo:

```
install_skill({ "package": "owner/repo@skill-name" })
```

## 3. Handle Results

**On success:**
- Tell the user which skill(s) were installed (use the `installed` array from the response)
- Briefly describe what the skill does (if you know from context)
- Mention they can manage it in the Skills page

**On failure:**
- Check if the package name format is correct
- Suggest the user verify the URL or package name
- Common issues:
  - Package not found: double-check the owner/repo spelling
  - Network error: ask user to retry
  - Invalid format: must be `owner/repo` or `owner/repo@skill`

## 4. Uninstalling

If the user wants to uninstall a skill, use the `uninstall_skill` MCP tool:

```
uninstall_skill({ "skill_id": "skill-name" })
```

The `skill_id` is the directory name of the installed skill.
