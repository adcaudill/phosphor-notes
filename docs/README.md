# Phosphor Notes Documentation Site

A custom Jekyll site for documentation and blog posts about Phosphor Notes. Features a clean, modern design with light/dark mode support using the SNOW color palette.

## Features

- **Custom Theme**: Two-column layout with sidebar navigation
- **Light & Dark Mode**: Automatic theme switching with persistent user preference
- **Blog Support**: Write and publish blog posts with optional author attribution
- **Documentation**: Auto-discovered markdown files in the documentation section
- **Material Symbols Icons**: Consistent with the Phosphor Notes app UI
- **Responsive Design**: Works beautifully on mobile and desktop

## To run locally:

1. Install Ruby and Bundler if you don't have them already.
2. Navigate to the `docs` directory in your terminal.
3. Run `bundle install` to install dependencies.
4. Run `bundle exec jekyll serve` to start the local server.
5. Open http://localhost:4000 in your browser.

## Structure

- `_layouts/` - Jekyll layout templates (default, home, page, post)
- `_includes/` - Reusable template components (header, sidebar, footer)
- `_posts/` - Blog posts (named as `YYYY-MM-DD-title.md`)
- `assets/` - Stylesheets and JavaScript
- `technical_notes/` - Technical documentation about the app
- `blog.md` - Blog archive page

## Adding Content

### Blog Posts

Create a new file in `_posts/` named `YYYY-MM-DD-title.md`:

```markdown
---
title: Your Post Title
date: 2026-02-16
author: Your Name
excerpt: "Optional excerpt shown in blog listings"
---

Your blog post content here...
```

### Documentation Pages

Add markdown files to the docs folder with front matter:

```markdown
---
title: Page Title
layout: page
---

Your documentation content here...
```

The navigation sidebar automatically discovers and lists all documentation pages.
