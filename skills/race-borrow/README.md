# race-borrow {badges}

<!-- badges: start -->
<a href="https://github.com/toxicwind/sovereign-projects">
  <img src="https://img.shields.io/badge/github-toxicwind/sovereign--projects-181717?style=for-the-badge&logo=github&logoColor=white" alt="GitHub repo">
</a>
<a href="https://bun.sh">
  <img src="https://img.shields.io/badge/bun-js_runtime-7f5af0?style=for-the-badge&logo=bun&logoColor=white" alt="Bun">
</a>
<!-- badges: end -->

## Race multiple providers for GitHub patterns and borrow the best results.

**What**: Combines parallel racing (first valid response wins) with pattern ranking — races GitHub repos across multiple providers and ranks by configurable weights.

**Why**: Find the best GitHub repos for given patterns by racing multiple providers concurrently and ranking results by stars, forks, open_issues, and updated status.

**Who**: Main script `race-borrow.ts` with race+borrow logic and dynamic argv. Triggers on: "race borrow", "race patterns", "borrow patterns", "multi-provider search", "race and rank", "find best repo".

## Feature bullets

- **Parallel Racing**: Races all provider×pattern combinations concurrently via `Promise.all`; first valid response wins per pattern
- **Pattern Ranking**: Winners ranked by configurable weights (stars, forks, open_issues, updated)
- **Dynamic argv**: `bun run race-borrow.ts [patterns...] [options]`
  - `--top N`: Number of top results to display (default: number of patterns)
  - `--per-page N`: Results per page from GH API (default: 5)
  - `--weights k=v,...`: Adjust ranking weights: stars, forks, open_issues, updated
  - `--providers p1,p2`: Select providers: openrouter, groq, google, mistral
  - `--interactive`: Enable interactive mode
  - `--help`: Show usage
- **GITHUB_TOKEN/GH_TOKEN**: Required environment variable
- **Bun runtime** required

## Quick start

```bash
# Basic: race sovereign, tau, pi patterns across default providers
bun run race-borrow.ts sovereign tau pi

# Custom: race with specific weights and providers
bun run race-borrow.ts coding-agent --weights stars=5,forks=2,updated=3 --providers openrouter,groq

# Top 3 results, 10 per page
bun run race-borrow.ts --top 3 --per-page 10
```

## Config / optional services

- **GITHUB_TOKEN/GH_TOKEN**: Environment variable required for GitHub API access
- **Bun runtime**: Required — `bun run /home/toxic/estate/skills/race-borrow/race-borrow.ts`
- **Providers**: openrouter, groq, google, mistral — select with `--providers` flag
- **Interactive mode**: `--interactive` for interactive pattern selection

## Dev / contributing

- Parses positional args as search patterns and optional flags
- Races all provider×pattern combinations concurrently via `Promise.all`
- For each pattern, the fastest valid response wins
- Winners ranked by configurable weights (stars, forks, open_issues, updated)
- Top results printed with repo details and winner provider
- GITHUB_TOKEN or GH_TOKEN must be set

## License + security

- **License**: Open Claw source (see `skill.toml`)
- **Security**: GITHUB_TOKEN/GH_TOKEN must not be committed to repos. Token exposure is the primary security concern — rotate immediately if committed.