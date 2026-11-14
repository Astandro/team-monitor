# Contributing to Team Monitor

Work happens on a branch per task (`tm/<task>`), reviewed before merge into `main`.

## Checks before a merge

```bash
npx -y pnpm@10 test
npx -y pnpm@10 --dir extension test
npx -y pnpm@10 --dir extension run lint
npx -y pnpm@10 --dir web exec tsc --noEmit
npx -y pnpm@10 run build:app
```

## Commits

- One focused change per commit, with a clear message.
- Keep existing copyright headers.

## License

Contributions are licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
