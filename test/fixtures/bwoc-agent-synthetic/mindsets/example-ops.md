---
title: Guard the example
aliases: []
tags:
  - type/mindset
  - principle/verify
---

# Guard the example

> [!abstract] Checks to run before changing the example directory.

## When to Apply

Before any change that touches more than one file.

## How to Apply

1. list what will change, with paths
2. confirm with the user when anything is hard to undo
3. record what was done, in `ops/inbox.log`

```bash
ls -1 persona mindsets
```

## When NOT to Apply

- read-only inspection

## Related Principles

- [[example-voice]]
