# Race-Borrow Skill

## Concept

Combines two powerful ideas:
- **Race**: Fire queries to multiple providers concurrently, first valid response wins
- **Pattern-Borrow**: Rank GitHub repos by configurable factors (stars, forks, issues, updated)

## Dynamic argv

```bash
bun run /home/toxic/estate/skills/race-borrow/race-borrow.ts [patterns...] [options]

Options:
  --top N            Number of top results to display (default: number of patterns)
  --per-page N       Results per page from GH API (default: 5)
  --weights k=v,...  Adjust ranking weights: stars, forks, open_issues, updated
  --providers p1,p2  Select providers: openrouter, groq, google, mistral
  --interactive      Enable interactive mode
  --help             Show usage
```

## Examples

```bash
# Basic: race sovereign, tau, pi patterns across default providers
bun run race-borrow.ts sovereign tau pi

# Custom: race with specific weights and providers
bun run race-borrow.ts coding-agent --weights stars=5,forks=2,updated=3 --providers openrouter,groq

# Top 3 results, 10 per page
bun run race-borrow.ts --top 3 --per-page 10
```

## How It Works

1. Parses positional args as search patterns and optional flags
2. Races all provider×pattern combinations concurrently via `Promise.all`
3. For each pattern, the fastest valid response wins
4. Winners are ranked by configurable weights (stars, forks, open_issues, updated)
5. Top results are printed with repo details and winner provider

## Requirements

- `GITHUB_TOKEN` or `GH_TOKEN` environment variable set
- Bun runtime

## Files

- `race-borrow.ts` — Main script with race+borrow logic and dynamic argv