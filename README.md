# Neon Drift: Word Runner

Mini English word learning runner game. Load a local `.txt` list, choose difficulty, and drift through neon lanes.

## Run locally

1) Install dependencies:

```bash
npm install
```

2) Start the dev server:

```bash
npm run dev
```

3) Open the URL shown in the terminal.

## Word list format

One word per line. Optional hint after ` - `.

```
abandon - to give up
focus - concentrate on something
drift
```

- Empty lines are allowed and can be removed.
- Duplicates can be removed (case-insensitive).

## Controls

- `1-4`: select answer lane
- `Enter`: submit typed answer (hard mode)
- `P`: pause/resume
- `M`: toggle sound

## Notes

- Progress, mastery, and daily goal are saved in `localStorage`.
- Google Fonts are used for typography; if offline, the app falls back to system fonts.
