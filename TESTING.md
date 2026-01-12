# Unit Testing Guide

This project uses **Vitest** for unit testing. Vitest is a fast, modern test framework built on Vite with excellent TypeScript support and a Jest-compatible API.

## Getting Started

### Running Tests

```bash
# Run tests in watch mode (default)
npm test

# Run tests once (CI mode)
npm test -- --run

# Run tests with UI
npm test:ui

# Generate coverage report
npm test:coverage
```

## Test Structure

Tests are co-located with source code using the `__tests__` directory pattern:

```
src/
  renderer/
    src/
      utils/
        taskParser.ts
        __tests__/
          taskParser.test.ts
  main/
    indexer.ts
    __tests__/
      taskExtraction.test.ts
```

## Current Test Coverage

### 1. Task Parser Tests (`src/renderer/src/utils/__tests__/taskParser.test.ts`)

**36 tests** covering the task metadata extraction engine:

- **Emoji-style dates**: `📅 2026-01-15`
- **Org-mode dates**: `DEADLINE: <2026-01-15>`
- **Recurrence intervals**: `🔁 +1d`, `+1w`, `+1m`, `+1y`
- **Completion timestamps**: `✓ 2026-01-12 14:30:45`
- **Date arithmetic**: Adding days, weeks, months, years
- **Date comparisons**: isPast, isToday, isFuture
- **Integration scenarios**: Complex tasks with multiple metadata types

### 2. Task Extraction Tests (`src/main/__tests__/taskExtraction.test.ts`)

**25 tests** covering the Markdown task indexing logic:

- **GFM task detection**: `- [ ]`, `- [/]`, `- [x]`
- **Line number tracking**: Accurate line counting in multi-line documents
- **Due date extraction**: Both emoji and Org-mode styles
- **Completion timestamps**: Extraction from task text
- **Edge cases**: Special characters, URLs, code snippets
- **Complex scenarios**: Multiple metadata on single task

## Philosophy

This test suite focuses on **focused, high-value tests** that validate core logic:

✅ **Good tests validate:**

- Date/time calculations (critical for task scheduling)
- Regex patterns (ensure metadata extraction works)
- Edge cases (month boundaries, multiple spaces, case sensitivity)
- Integration scenarios (realistic usage patterns)

❌ **Avoid:**

- Generic coverage-driven tests
- Tests that just verify pass-through functions
- Mock-heavy tests that don't catch real bugs

## Key Testing Patterns

### Testing Utilities

```typescript
import { describe, it, expect } from 'vitest';
import { parseTaskMetadata, formatDate, addInterval } from '../taskParser';

describe('Task Parser', () => {
  it('should parse emoji-style due date', () => {
    const text = 'Task 📅 2026-01-15';
    const metadata = parseTaskMetadata(text);
    expect(formatDate(metadata.dueDate!)).toBe('2026-01-15');
  });
});
```

### Testing Regex Patterns

```typescript
it('should extract Org-mode DEADLINE case-insensitive', () => {
  const text = 'Task deadline: <2026-01-15>';
  const metadata = parseTaskMetadata(text);
  expect(metadata.dueDate).not.toBeNull();
});
```

### Testing Edge Cases

```typescript
it('should handle multiple spaces between emoji and date', () => {
  const text = 'Task 📅  2026-01-15'; // Two spaces
  const metadata = parseTaskMetadata(text);
  expect(formatDate(metadata.dueDate!)).toBe('2026-01-15');
});
```

## Adding New Tests

When adding new features, write tests that:

1. **Validate the core behavior** - What should this do?
2. **Test edge cases** - What might break this?
3. **Verify integration** - How does this work with other parts?

Example: Adding a new task priority feature:

```typescript
describe('Task Priority', () => {
  it('should extract priority emoji', () => {
    const text = 'High priority task 🔴 📅 2026-01-15';
    const metadata = parseTaskMetadata(text);
    expect(metadata.priority).toBe('high');
  });

  it('should prioritize tasks in sorting', () => {
    const tasks = [...].sort(byPriority);
    expect(tasks[0].priority).toBe('high');
  });
});
```

## Test Maintenance

- **Update tests when requirements change** - Tests are documentation
- **Refactor tests as code is refactored** - Keep them in sync
- **Delete redundant tests** - Focus over coverage
- **Add tests for real bugs** - Create regression tests

## Continuous Integration

Tests run automatically on:

- Pull requests
- Commits to main
- Before production builds

The build fails if any test fails. Keep the test suite passing!

## Resources

- [Vitest Documentation](https://vitest.dev)
- [Testing Library](https://testing-library.com) (for React component tests - add when needed)
- [Jest API Reference](https://jestjs.io/docs/api) (Vitest is compatible)
