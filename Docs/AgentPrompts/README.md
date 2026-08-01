# Parallel Agent Prompts

These prompts delegate the product workstreams that follow the platform security kernel. Dispatch each prompt to a fresh agent. Every implementation agent must use its own Git worktree and branch based on the latest `feature/deployable-pilot` commit.

Recommended dispatch order:

1. Dispatch agents 01-05 in parallel after platform Task 12 is committed.
2. Keep changes isolated; do not merge implementation branches into each other.
3. Dispatch agent 06 after agents 01-05 have completed and supplied commit SHAs.

Files:

- `01-process-task-workflow.md`
- `02-evidence-risk-resource.md`
- `03-governed-ai-rag.md`
- `04-desktop-product.md`
- `05-deployment-release.md`
- `06-final-integration-acceptance.md`

Each agent has delegated product and engineering decision authority. It should ask a question only when a missing external credential, legal choice, or unavailable infrastructure makes completion impossible.
