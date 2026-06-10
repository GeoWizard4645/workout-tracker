# Workout Tracker

A zero-cost, offline-first workout tracker built as a web app you install on your
iPhone home screen. No accounts, no servers, no AI APIs — everything is plain
HTML/CSS/JS and all your data stays on your phone.

## Features

- **Muscle map** — front/back body diagram on the home screen, colour-coded by how
  recently each muscle was trained (green = fresh → red = neglected/never).
- **Suggestions** — rule-based engine (no AI) scores the classic splits
  (push / pull / legs / upper / core / full body) by how neglected their muscles are
  and suggests what to train today. Leg muscles are exempt from the
  "needs training" list by default (toggle in Settings).
- **Workout planner** — pick a split or custom muscles, exercise count and your
  available equipment; it generates a workout from a built-in library of ~57
  exercises (compounds first). Shuffle, edit, save as a reusable plan, or start it.
- **Live sessions** — start from a suggestion, a plan, an empty session, or repeat
  your last workout. Log weight × reps per set with a running timer. A session
  survives closing the app — you'll be dropped right back into it.
- **History** — calendar with workout dots, per-day session details, weekly/all-time
  stats.
- **Backup** — export/import all data as a JSON file from Settings.

## Where the data lives (and why it won't disappear)

There is no database server — that's how it stays free. Instead, every change is
written to **two independent stores on the device**: `localStorage` *and*
`IndexedDB`. On launch the app compares both and restores from whichever copy is
newest, so even if the browser clears one store, nothing is lost. The app also
requests *persistent storage* from the browser so it is excluded from automatic
cleanup.

On iOS, a home-screen web app gets its own storage container that survives
closing the app, closing Safari, restarting the phone, and clearing Safari
history. Your data only goes away if you delete the app icon itself (or
"Erase All Data" in Settings). For belt-and-braces safety, export a JSON backup
from Settings occasionally — especially before major iOS updates or when
switching phones.

## Hosting at workout.vivaanshahani.com

The repo includes a `CNAME` file pointing at `workout.vivaanshahani.com`, and
GitHub Pages serves the app. To finish the custom domain, add this DNS record
wherever `vivaanshahani.com` is managed:

| Type  | Name      | Value                       |
| ----- | --------- | --------------------------- |
| CNAME | `workout` | `geowizard4645.github.io`   |

Then in the GitHub repo: **Settings → Pages → Custom domain** should show
`workout.vivaanshahani.com` — tick **Enforce HTTPS** once the certificate is
issued (can take up to an hour after the DNS record propagates).

Until DNS is set up, the app is live at the default Pages URL.

## Install on your iPhone

1. Open that URL in **Safari**.
2. Tap the **Share** button → **Add to Home Screen** → **Add**.
3. Launch it from the icon — it runs full-screen like a native app, and after the
   first load it works fully offline.

Other free hosts that work the same way: Netlify Drop (drag the folder onto
netlify.com/drop), Cloudflare Pages, Vercel.

### Updating the app later

Edit the files, bump the `VERSION` string at the top of `sw.js`
(e.g. `wtt-v2`), and re-upload. Installed phones pick up the new version the next
time the app is opened with a connection (close and reopen once).

## Run it locally

Any static server works:

```bash
python3 -m http.server 8743
# then open http://localhost:8743
```

## Files

| File | What it is |
| --- | --- |
| `index.html` | App shell, iOS PWA meta tags, SVG body-map templates |
| `style.css` | Dark theme, safe-area handling, mobile-first layout |
| `data.js` | Hard-coded muscle groups, splits and exercise library |
| `app.js` | All app logic: storage, recency engine, suggestions, planner, sessions, history |
| `sw.js` | Service worker — caches everything for offline use |
| `manifest.webmanifest` | Web-app manifest (name, icons, standalone display) |
| `icon-180.png`, `icon-512.png` | Home-screen icons |
