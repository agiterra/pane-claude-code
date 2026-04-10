---
description: Build or complete a pane theme — generate pool names, fetch background images, write theme.json. Run with a background Sonnet agent for best results.
allowed-tools: Agent, Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch
---

# Theme Builder

Build or complete a Crew pane theme. Themes define a name pool and background
images for iTerm2 panes.

## Usage

- `/crew:theme-build trees` — fill missing images for the "trees" theme
- `/crew:theme-build "classic cars"` — create a new theme from scratch

## Modes

### Fill gaps (theme already exists)

1. Load `theme.json` from `~/.wire/themes/<name>/` or `~/.crew/themes/<name>/`
2. List pool names that have no matching image file
3. For each missing name, search Pexels for a suitable image:
   - Query: `"<name> <theme-context> texture background"`
   - Target: warm, medium-dark tones that look good at 50% blend on a dark terminal
   - Resolution: 1920x1080 crop
4. Download via Pexels API: `https://images.pexels.com/photos/<id>/pexels-photo-<id>.jpeg?auto=compress&cs=tinysrgb&w=1920&h=1080&fit=crop`
5. Save as `<name>.jpg` in the theme directory
6. Update `theme.json` images map with new entries
7. Report what was added

### New theme (no existing theme.json)

1. Parse the topic from `<args>`
2. Generate a pool of 20 names related to the topic
3. Create the theme directory at `~/.wire/themes/<theme-name>/`
4. Write `theme.json` with the pool, default blend (0.5), mode (2)
5. For each name, search Pexels and download a background image
6. Update images map in theme.json
7. Report the complete theme

## Image Selection Guidelines

- **Texture/close-up shots work best** — wood grain, stone surfaces, fabric weaves
- **Avoid images with text, people, or busy scenes** — they distract from terminal content
- **Medium brightness preferred** — not pitch black (invisible at 50% blend), not white (washes out text)
- **Warm tones** — browns, ambers, warm grays look best on dark terminals
- **Consistent style within a theme** — all images should feel like they belong together

## Pexels Download

Pexels allows direct curl downloads with this URL pattern:
```
https://images.pexels.com/photos/{PHOTO_ID}/pexels-photo-{PHOTO_ID}.jpeg?auto=compress&cs=tinysrgb&w=1920&h=1080&fit=crop&q=80
```

To find photo IDs, search Pexels and extract IDs from the page. The WebFetch
tool can parse Pexels search result pages to find photo IDs.

## Post-download: Resize

After downloading all images, resize any that are over 500KB to 1920x1080
using macOS `sips` (no ImageMagick needed):

```bash
for f in <theme-dir>/*.jpg; do
  size=$(stat -f%z "$f")
  if [ "$size" -gt 524288 ]; then
    sips -z 1080 1920 "$f" --out "$f" 2>/dev/null
  fi
done
```

This keeps the theme directory under a few MB total. Wikimedia/Pexels source
images can be 10-30MB — always resize.

## Image Sources

Prefer these free sources (in order):
1. **Pexels** — direct curl downloads, no auth needed
2. **Wikimedia Commons** — public domain, species-accurate for natural themes
3. **Unsplash** — great quality but curl downloads often blocked (use browser)

## Important

- Always verify downloaded files are valid JPEGs (`file <path>` should say "JPEG image data")
- Delete and retry if a download produces HTML instead of an image
- After completing, show a summary of pool coverage: N/M names have images

## Badge Colors (per image)

For each downloaded image, choose a badge color that will be readable when
displayed in the **top-right corner** of the pane. The background image is
scaled to fill (mode 2), so the visible top-right region depends on pane
aspect ratio but generally shows the top-right ~25% of the image.

1. Sample the top-right region of each image to understand its dominant colors.
   You can use `sips` to crop and inspect:
   ```bash
   sips -c 270 480 --cropOffset 0 1440 <image> --out /tmp/tr.jpg
   sips -g all /tmp/tr.jpg
   ```
   Or use ImageMagick `identify -format '%[pixel:p{1800,50}]' <image>` to pick
   a sample pixel.

2. Pick a badge color that has **high contrast with both**:
   - The dominant color of the top-right region of the background image
   - The terminal's foreground text color (typically near-white / light gray)

   The badge overlays the terminal text area, so it must be readable against
   the BLENDED result: background image (top-right crop) × 0.5 opacity +
   dark terminal background, with white terminal text possibly passing through.

   Avoid:
   - **Red** (operator preference)
   - **Pure white / very light colors** (collide with terminal text)
   - **Very dark colors** (disappear into dark terminal)

   Good choices are mid-saturation warm tones: amber, gold, burnt orange,
   olive, teal, or saturated mid-tone blues/greens that differ from the
   image's dominant hue.

   Use alpha 0.85 for slight transparency.

3. Write the chosen color into `theme.json` under `badgeColors[<name>]`:
   ```json
   {
     "badgeColors": {
       "oak": { "r": 1, "g": 0.85, "b": 0.3, "a": 0.85 },
       "marble": { "r": 0.2, "g": 0.3, "b": 0.6, "a": 0.85 }
     }
   }
   ```
   Components are 0..1 floats. Alpha defaults to 0.85 if omitted.

4. Optionally set `defaultBadgeColor` as a fallback for any pane without a
   specific entry.
