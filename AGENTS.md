# Agent Instructions

- Do not run `npm run serve`, `npm run dev`, or any other local dev server unless the user explicitly asks for it in the current turn.
- If a browser preview or local URL check would be useful, ask first instead of starting a server proactively.
- Commit completed changes to git before the final response unless the user explicitly asks not to.
- Do not add Co-Authored-By or any Claude attribution lines to commit messages.
- Commit incrementally as you go: after each self-contained, verified unit of work (passing lint/tests), make a focused commit rather than batching everything into one commit at the end.
- When the plan is well known and the user asks to continue, keep implementing the next roadmap item until checks pass, an issue blocks progress, or user testing is useful.
- Keep final responses concise. Suppress routine/expected command output; summarize successful verification as "Checks passed." unless the user asks for details.
- Bubble up errors, failed checks, skipped checks, or unusual risks explicitly.
- When ending with forward-looking guidance, use a `Next steps:` section title followed by the concise recommendation.
