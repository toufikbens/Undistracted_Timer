# Pomodoro

A minimalist dark theme Pomodoro timer that runs in any modern browser.

## Share Online With GitHub Pages

This project is ready to publish as a static GitHub Pages site. After you push it to a GitHub repo, GitHub can host it at:

```text
https://YOUR-GITHUB-USERNAME.github.io/YOUR-REPO-NAME/
```

If you name the repo `pomodoro`, the URL will look like:

```text
https://YOUR-GITHUB-USERNAME.github.io/pomodoro/
```

### First Publish

Create a new empty GitHub repo, then run these commands from this folder:

```sh
git init
git add .
git commit -m "Initial Pomodoro app"
git branch -M main
git remote add origin https://github.com/YOUR-GITHUB-USERNAME/YOUR-REPO-NAME.git
git push -u origin main
```

Then open the repo on GitHub and go to:

```text
Settings -> Pages -> Build and deployment -> Source -> GitHub Actions
```

Every push to `main` will deploy automatically. The public URL appears in the deploy job and on the repo's Pages settings screen.

## Run

On macOS, double-click:

```text
start-pomodoro.command
```

Or from this folder:

```sh
python3 -m http.server 4173
```

Then open:

```text
http://localhost:4173
```

## Features

- Focus, short break, and long break modes
- Precise timer that stays accurate when the tab is backgrounded
- Configurable durations and long-break cadence
- Optional completion chime and browser notifications
- Today's focus session and minute counters
- Current intention field with local persistence
- Keyboard shortcuts: Space starts or pauses, R resets, S skips, 1/2/3 switch modes
