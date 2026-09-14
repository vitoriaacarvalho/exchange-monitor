---
name: sparse-comments
description: >-
  Comment discipline for this repo — write few comments, and only where the
  code cannot speak for itself. Load before writing or editing any source
  file, and when reviewing a diff for comment noise. Signals that it applies:
  adding a comment, writing a new module, a docblock on every export, section
  banners, or a code review that mentions readability or over-documentation.
---

# Sparse comments

Default to **no comment**. The code is the documentation; a comment is an
admission that it failed. Most code doesn't need one.

## The only test

Write a comment when a competent reader of *this* code would still get
something wrong — and the comment tells them the thing they can't see:

- **A constraint from outside the file.** A library's quirk, a runtime
  limitation, a wire format, a name the database actually uses.
- **A decision that looks wrong.** Explain why the obvious approach fails,
  so the next person doesn't "fix" it back.
- **A consequence that isn't local.** Deleting this line breaks something
  three files away.
- **A fact that was expensive to learn.** Something verified by probing or
  debugging that no one should have to rediscover.

If the answer is "the code already says this", delete it.

## Never write

- Restatements: `// increment the counter` over `counter++`.
- Docblocks on self-describing functions. `notFound(message)` needs no prose.
- Section banners (`// --- Routes ---`) — that's what blank lines and file
  boundaries are for.
- Tutorials on the language or framework. Assume a competent reader.
- Narration of what you just did, changelog entries, or `// TODO` without a
  concrete next step.
- Restating a type that's right there in the signature.

## Shape

One line, above the code, in plain prose. A short paragraph only when the
reasoning genuinely needs it. Prefer a better name or a smaller function over
a comment explaining a bad one.

A module deserves a header comment only when its *purpose* is non-obvious
from its name and exports — not as a matter of routine.

## Editing existing code

Match the file you're in: a densely documented file stays that way, and a
terse one stays terse. Don't strip comments from code you weren't asked to
touch. When you do rewrite a block, apply the test above to the comments you
carry over rather than preserving them by default.
