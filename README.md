# phosphor-notes

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### First run / Expected behavior

On the first run the app will prompt you to select a folder (a "vault"). The app will create and open today's note (format `YYYY-MM-DD.md`) in that folder. Typical first-run flow:

- Pick a folder when prompted
- The app creates `YYYY-MM-DD.md` (if missing) and opens it in the editor
- Type, pause, and the editor saves the file to disk

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```
