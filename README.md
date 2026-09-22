# Wait, What?

**Legendary Creature edition** — a mobile-first, installable web player for the Legendary Creature Podcast. The player uses the audio element's real `currentTime` to show the Magic card being discussed, so returning after a phone lock does not depend on background JavaScript timers.

## First milestone

The prototype is wired to **The Hobbit | Legends Review** from 19 August 2026. It plays the episode's Libsyn enclosure and includes a hand-verified cue sheet for eight opening cards, from Belladonna Took at 1:33 through Bilbo, Thief in the Night at 26:33. The publisher's transcript and player both refer to the same Libsyn episode asset.

The episode selector is populated from the current RSS feed snapshot. Episodes without cue sheets are visible but disabled; run the processing workflow before enabling one.

## Run locally

Requirements: Python 3 (only for the static server) and Node.js 22+ (for tests and processing utilities).

```bash
npm run dev
```

Open `http://localhost:4173`. Run the fast timestamp-selection tests with:

```bash
npm test
```

Refresh the static episode list from the RSS feed:

```bash
npm run refresh-feed
```

No application server, database, account, or API key is required during playback.

## Install on a phone

- iPhone/iPad: open the HTTPS deployment in Safari, use **Share → Add to Home Screen**, then launch the installed app.
- Android: open the HTTPS deployment in Chrome and choose **Install app** or **Add to Home screen**.

The service worker caches the app shell, episode metadata, and cue sheet. Podcast audio and Scryfall images remain network resources. A continuous HTML `<audio>` element is used so iOS and Android can keep audio playing in the background where the browser allows it.

## Episode processing

The processor deliberately separates expensive preparation from playback:

1. Download the exact audio asset used by the player (or supply a local file).
2. Transcribe it ahead of time with the local Whisper CLI and segment timestamps.
3. Download and cache Scryfall's `default_cards` bulk catalogue.
4. Match normalized transcript windows to real catalogue names. Exact matches score `1`; fuzzy matches must clear the configured threshold.
5. Collapse repeated mentions and write static cue-sheet JSON with Scryfall IDs, names, timestamps, confidence, card text, and image data.
6. Mark matches below `0.94` with `needsReview: true` for human review.

Install the local Whisper CLI first (for example, `pipx install openai-whisper`) and ensure `ffmpeg` is available. Then process directly from an RSS enclosure URL:

```bash
npm run process-episode -- \
  --url 'https://traffic.libsyn.com/secure/legendarycreaturepocast/352-The_Hobbit_Legends_mixdown.mp3?dest-id=534396' \
  --sets hob,hoc \
  --output dist/data/hobbit-legends-review.generated.cues.json
```

For an existing audio file, use `--audio episode.mp3`. For a publisher-provided transcript or a prior transcription, use `--transcript episode.srt`; both SRT and Whisper JSON are accepted. The bulk catalogue is cached in `.cache/scryfall/` and subsequent runs do not make per-card API calls.

Review generated cues, correct or remove low-confidence items, add the final cue-sheet path to `dist/data/episodes.json`, and set that episode's `processed` field to `true`. The matcher can tolerate whole-name transcription errors such as "Keeley the Resourceful" because it scores word windows, but it never emits a cue unless the result maps to an actual Scryfall record.

Double-faced and Adventure layouts are retained through `card_faces`; the UI renders face-specific rules and falls back to a face image when top-level `image_uris` is absent.

## Timestamp and ad-insertion limitation

Dynamic ad insertion can make a publisher's enclosure change length or content after a cue sheet is produced. A cue sheet is valid only for the exact audio bytes used during processing. This milestone minimizes drift by using the current Libsyn enclosure together with its publisher-hosted transcript, but it does not checksum or self-host the MP3.

For production, record an audio checksum and duration in episode metadata. If the enclosure changes, reject the old cue sheet and reprocess. The most deterministic alternative is to host a licensed, immutable copy of the processed audio and point both the processor and player to that asset.

## Background-playback test checklist

Desktop browser testing cannot prove mobile background behavior. Before calling the PWA production-ready, test the HTTPS deployment on a physical iPhone and Android phone:

1. Start playback, lock for at least two minutes, and confirm uninterrupted audio.
2. Unlock and return to the installed PWA; the card should reconcile immediately from `audio.currentTime`.
3. Seek from the lock screen if the platform exposes controls, return to the app, and confirm the card changes.
4. Interrupt with a call or another audio app, resume, and verify position and card state.
5. Test Safari/installed PWA on the oldest supported iOS and Chrome/installed PWA on Android.

The app also reconciles on `seeking`, `seeked`, `play`, `playing`, `pageshow`, window focus, and `visibilitychange`. It does not use a timer to infer progress while hidden.

## Project layout

- `dist/` — deployable static PWA.
- `dist/data/` — RSS snapshot and static cue sheets.
- `scripts/fetch-rss.mjs` — RSS ingestion.
- `scripts/process-episode.mjs` — audio download, transcription orchestration, bulk-catalogue matching, and cue generation.
- `tests/` — cue selection, history, image fallback, and time-formatting tests.

Scryfall card data and images are used in accordance with Scryfall's public API guidance. This is an unofficial fan prototype and is not affiliated with Legendary Creature Podcast, Wizards of the Coast, or Scryfall.
