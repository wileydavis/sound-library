# Sound Library

A private catalog for field recordings, impulse responses and voices, running on Cloudflare.
You drop recordings on a web page. The page reads the MixPre metadata, listens for your spoken
slate, suggests a title, tags, description and location, and lets you fix anything. It then makes
a clean clip in the browser and uploads both the untouched original and the clip. A searchable
library lets you preview, edit and download.

- **Add**: drag files in → review → *Process & upload*
- **Library**: search titles, tags, places, people *and what was said*; preview; edit; download one,
  a .zip, or *Save to folder…* straight into a folder Ableton browses (Chrome/Edge). Downloads are
  named after the title. **Map** view shows every located sound; moving the map filters the list.
- **Location words** (`/where`, for your phone): four words that encode your GPS position to about 10 m.
  It works offline. Say *"location"* and the four words in your slate.

## How a take should start

> "Railyard, freight brakes, cold morning, 416 on the boom. Location scorpion cotton sea point."
> *(pause, then record)*

- The slate becomes the title, tags and description, and is cut from the clip (you can untick that).
- "Location" plus the four words become coordinates. If you've named a place within ~1.5 km before,
  that name is suggested. Nothing is sent to an outside map service.
- Voice recordings (interviews, singing) are transcribed in full, so you can search for what people said.
  They're marked *no release* until you set a release status.

## What gets stored (R2 bucket `sound-library`)

```
originals/2026/2026-11-07/<id>_<original-name>.wav   ← byte-for-byte what the recorder wrote
clips/<type>/2026-11-07_<title>_<id>.wav             ← cleaned clip (24-bit or 32f, original sample rate)
meta/<id>.json                                       ← everything about it, readable without the app
```

The D1 database is an index of the same information. Clips also carry their title, description and
tags inside the WAV (BWF `bext` + `LIST/INFO`), so other sample browsers can read them too.

Cleanup chain (runs in the background in your browser; *Preview cleaned* lets you hear it first):
cut slate → 40 Hz high-pass (24 dB/oct) → **noise reduction** → normalize → 5 ms / 20 ms fades → 24-bit.

- **Noise reduction** learns the steady background (hiss, wind rumble, HVAC) from the quietest
  moments of each file and turns it down by 8 / 14 / 22 dB (light / medium / strong) wherever it
  isn't masked by the sound you recorded. It lowers the background rather than muting it, so
  ambiences keep their air. *Auto* = medium for voice, light for field/tonal, off for IRs.
- **Normalize** *auto* = −18 LUFS (peak ≤ −1 dBFS) for voice, peak −1 dBFS for everything else.
- Also available: head/tail silence trim, 32-bit float output, mono mix, or a single MixPre track
  (track names come from iXML).

Maps use OpenStreetMap and OpenTopoMap tiles (no account needed). Viewing the map fetches tiles
for the area you look at from those services; nothing else about your library leaves Cloudflare.

## Setup (one time, about 15 minutes)

You need Node 20+ and your Cloudflare account. From this folder:

```bash
npm install
npx wrangler login

# 1. Storage and database
npx wrangler r2 bucket create sound-library
npx wrangler d1 create sound-library
#    → copy the database_id it prints into wrangler.jsonc ("REPLACE_WITH_D1_ID")
npm run db:remote

# 2. Deploy
npx wrangler deploy
```

This puts the app at **library.drosaka.com**, set in `routes` in `wrangler.jsonc` (change it if you
like). Until step 3 is done, every API call is refused. That's deliberate.

### 3. Lock it to you with Cloudflare Access

1. Cloudflare dashboard → **Zero Trust** → **Access** → **Applications** → *Add an application* → *Self-hosted*.
2. Domain: `library.drosaka.com`. Session duration: something long, like 1 month.
3. Policy: *Allow*, **Emails** = your address. Login method: one-time PIN is fine.
4. Save, then open the application and copy the **Application Audience (AUD) Tag**.
5. Your team domain is under Zero Trust → Settings → Custom Pages, e.g. `yourteam.cloudflareaccess.com`.
6. Put both into `wrangler.jsonc` → `vars` (`ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`) and `npx wrangler deploy` again.

Access stops strangers at Cloudflare's edge. The Worker also checks the Access token's signature on
every API call, so even a misconfigured route can't expose the library. The `workers.dev` URL is
turned off for the same reason.

### 4. Phone

Open `https://library.drosaka.com/where` on your phone once while you have signal, sign in, and
*Add to Home Screen*. After that it opens and works with no signal. *Log this spot* keeps a list
of spots on the phone.

## Costs

R2 storage is $0.015 per GB-month (first 10 GB free), and downloads are free. Transcription uses
Workers AI Whisper, a fraction of a cent per minute of audio, plus a small language model for
descriptions. Both come out of Workers AI's free daily allowance for normal use.

## Local development

```bash
npm run db:local   # create the local database
npm run dev        # http://localhost:8787 — no login, fake transcription, local storage
npm test           # audio, WAV, slate, location-word and auth tests
```

## Files

```
src/worker.js          API: uploads (multipart above 90 MB), catalog + full-text search, file
                       streaming with Range, transcription/description, Access verification
schema.sql             D1 tables + FTS5 search index
public/index.html      the app (Library + Add)
public/where.html      phone page for location words (offline via sw.js)
public/js/wav.js       WAV/BWF/RF64 reader + writer (16/24/32-bit PCM, 32/64-bit float, bext, iXML, INFO)
public/js/dsp.js       high-pass, LUFS (BS.1770-4), noise floor, trim, fades, normalize, waveform peaks
public/js/denoise.js   spectral noise reduction (streaming STFT, shared mask across channels)
public/js/clip.js      the cleanup chain; runs in clip.worker.js off the main thread
public/js/geowords.js  GPS ↔ four words (BIP39 English word list, MIT)
public/js/slate.js     slate detection and metadata guesses
public/js/ingest.js    Add tab
public/js/library.js   Library tab
public/js/zip.js       .zip writer for multi-file downloads
```

## Not built yet (good next steps)

- Impulse responses: deconvolve sine-sweep recordings into IRs automatically.
- "Sounds like this" similarity search (CLAP audio embeddings + Cloudflare Vectorize).
