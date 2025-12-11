# Contributing to Grov

Thanks for your interest in contributing to Grov! This document outlines how to get started.

## Community

- **Reddit:** [r/useGrov](https://www.reddit.com/r/useGrov/) - Discuss ideas, ask questions, share feedback
- **GitHub Issues:** Bug reports and feature requests

## Ways to Contribute

- **Report bugs** - [Open a bug report](https://github.com/TonyStef/Grov/issues/new?template=bug_report.md)
- **Suggest features** - [Open a feature request](https://github.com/TonyStef/Grov/issues/new?template=feature_request.md)
- **Submit code** - Fix bugs, add features, improve documentation
- **Security issues** - See [SECURITY.md](SECURITY.md) for responsible disclosure

## Development Setup

### Prerequisites

- Node.js 20+
- pnpm 9+

### Getting Started

```bash
# Fork the repo on GitHub, then clone your fork
git clone https://github.com/YOUR_USERNAME/Grov.git
cd Grov

# Install dependencies
pnpm install

# Build
pnpm build

# Test CLI locally
node dist/cli.js --help
```

### Project Structure

This is a monorepo using pnpm workspaces and Turborepo:

```
├── src/           # CLI source code (main package)
├── api/           # Backend API server
├── dashboard/     # Next.js web dashboard
├── landing/       # Astro landing page
├── shared/        # Shared types and utilities
```

### Development Commands

```bash
pnpm dev              # Watch mode for CLI
pnpm dev:api          # Run API server
pnpm dev:dashboard    # Run dashboard locally
pnpm build:all        # Build all packages
```

## Submitting Changes

### Branch Naming

Use prefixes for your branches:

- `feat/` - New features (e.g., `feat/semantic-search`)
- `fix/` - Bug fixes (e.g., `fix/token-refresh`)
- `docs/` - Documentation (e.g., `docs/api-reference`)
- `refactor/` - Code refactoring
- `test/` - Test additions/fixes

### Pull Request Process

1. Fork the repository
2. Create a branch from `main` (`git checkout -b feat/my-feature`)
3. Make your changes
4. Build and verify (`pnpm build`)
5. Push to your fork
6. Open a Pull Request against `main`

See the [PR template](.github/PULL_REQUEST_TEMPLATE.md) for what to include.

## Code Style

- **TypeScript** - All code is written in TypeScript
- **ESM** - Project uses ES modules (`"type": "module"`)
- **Formatting** - Keep code consistent with existing patterns

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
