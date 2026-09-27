# Wait, What?

An installable, mobile-first web player for **Legendary Creature Podcast**, **MTGGoldfish Podcast**, and **MTGGoldfish Commander Clash Podcast**. A landing page and persistent podcast selector make each show independently browsable. The player uses the audio element's real `currentTime` to show the Magic card being discussed, so returning after a phone lock does not depend on background JavaScript timers.

## First milestone

The prototype is wired to both **The Hobbit | Legends Review** and **The Hobbit | Cards for the Other 99** from August 2026. It plays the episodes' Libsyn enclosures and includes reviewed full-episode cue sheets generated from the publisher's timestamped transcripts. The publisher's transcripts and player refer to the same Libsyn episode assets.

Each episode selector is populated from its current RSS feed snapshot. Episodes without cue sheets remain playable and show a clear card-syncing-pending state; run the processing workflow to add synchronized cards.

## Run locally

Requirements: Python 3 (only for the static server) and Node.js 22+ (for tests and processing utilities).

```bash
npm run dev
```

Open `http://localhost:4173`. Run the fast timestamp-selection tests with:

```bash
npm test
```

The local development server also exposes `http://localhost:4173/reviews`, a human-review workspace that is intentionally absent from the deployable `dist/` directory. It shows each unresolved name beside the matching transcript and a ten-second audio clip. Saving a correction writes `resolvedName` and `resolvedAt` back to that episode's `reviews/*.needs-review.json` file.

Paste the matching Scryfall card URL as the correction, then apply all completed reviews to their cue sheets with `npm run apply-reviews`. The command embeds canonical card data at the reviewed timestamps and adds each resolved name to the episode's approved-card list; review entries left blank are preserved and skipped.

Refresh the static episode lists from all three RSS feeds:

```bash
npm run refresh-feed
```

Refresh only one feed with `--show=legendary-creature`, `--show=mtggoldfish`, or `--show=commander-clash`.

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

To match every correctly transcribed card name against TurnZero's local MTGJSON catalogue, use the AtomicCards file without a set filter:

```bash
npm run process-episode -- \
  --transcript episode.srt \
  --catalogue catalog/AtomicCards.json \
  --sets all \
  --exact-only \
  --output dist/data/episode.cues.json
```

MTGJSON does not carry a preferred printing image in `AtomicCards.json`, so generated cues use Scryfall's exact-name image endpoint while all names, rules text, mana costs, and type lines come from the local catalogue.

Exact spelling alone is not enough for common words that are also card names (for example `Consider`) or the first face of a split card (for example `Down // Dirty`). After reviewing matches in context, save the accepted canonical names as a JSON array and pass it with `--approved-cards reviews/episode.approved-cards.json`. This makes a reviewed cue sheet reproducible without hand-editing generated JSON.

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
- `dist/data/` — show catalogue, per-show RSS snapshots, and static cue sheets.
- `scripts/fetch-rss.mjs` — multi-feed RSS ingestion.
- `scripts/process-episode.mjs` — audio download, transcription orchestration, bulk-catalogue matching, and cue generation.
- `tests/` — cue selection, history, image fallback, and time-formatting tests.

Scryfall card data and images are used in accordance with Scryfall's public API guidance. This is an unofficial fan prototype and is not affiliated with Legendary Creature Podcast, MTGGoldfish, Wizards of the Coast, or Scryfall.
