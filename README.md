# Twitter Media Assist — coco-is-magik fork

A browser extension for downloading media from Twitter/X, including converting animated video clips to GIFs.

This fork builds on **Flkalas's Twitter Media Assist**. Thank you to the original author and contributors for the extension and its foundations. This fork focuses on preventing duplicate downloads and improving GIF worker and memory cleanup; it is not the original project's official release.

## Project links

| Link | What it is |
| --- | --- |
| [coco-is-magik/TwitterMediaAssist](https://github.com/coco-is-magik/TwitterMediaAssist) | **This fork:** source code and the fixes described below. |
| [Flkalas/TwitterMediaAssist](https://github.com/Flkalas/TwitterMediaAssist) | **Original upstream project:** the source repository this fork builds on. |
| [Original Firefox add-on listing](https://addons.mozilla.org/en-US/firefox/addon/twitter-media-assist-ff) | Firefox store link preserved from the upstream README; not a distribution of this fork's fixes. |
| [Original Chrome Web Store listing](https://chrome.google.com/webstore/detail/twitter-media-assist/cledppeceojodgghbbkaciochldmpdfk) | Chrome store link preserved from the upstream README; not a distribution of this fork's fixes. |

The store links are provided for attribution and reference, not as installation links for this fork. Their current availability has not been verified.

## Changes in this fork

### Duplicate-download prevention

- Deduplicates matching cached media within a single download click.
- Shares in-progress requests for the same media, including URLs differing only in supported delivery tags or image-size parameters.
- Keeps requests tracked until their downloads complete or fail, rather than only until the browser returns a download ID.
- Allows intentional re-downloads after completion and retries after failure.
- Preserves GIF and MP4 output preferences. **Both formats remain enabled by default:** one `.gif` plus one `.mp4` is intentional, not an identical-file duplicate.

### GIF conversion and resource cleanup

- Gives each conversion its own worker instead of identifying workers by filename, preventing collisions between same-named files.
- Uses sequential frame seeking and worker acknowledgements, with one frame in flight per conversion rather than an unbounded frame queue.
- Guards against repeated initialization and completion events.
- Adds a **30-second inactivity timeout per conversion operation**, along with cleanup for video, worker, drawing, seeking, and message failures. This is not a 30-second limit on the entire GIF.
- Terminates workers, clears handlers and timers, releases video sources, and resets canvas buffers when conversion ends.
- Transfers binary frame and GIF output buffers instead of passing through Base64 strings and intermediate character arrays.
- Revokes generated GIF and TS Blob URLs when downloads complete, are interrupted, are removed, or fail to start.

Image downloads also retain their format parameters and use explicit filenames rather than a shared filename-renaming listener. Existing readable-name and save-location preferences remain supported.

These changes address resource ownership and unnecessary copies; they do not make large GIFs memory-free. Encoding still holds the output GIF in memory, and distinct media can be processed concurrently.

## Tests and verification

The regression suite uses Node.js built-ins; no npm dependencies are required. From the repository root, run:

```sh
node --test tests/download-lifecycle.test.cjs
```

Verification on October 20, 2026 used Node.js 26.3.0:

- **19 tests passed**, with no skips, covering duplicate requests, retries, settings, worker ownership, repeated events, failure cleanup, and download lifecycle handling.
- The suite executes the bundled GIF encoder, rather than mocking the encoder itself.
- With FFmpeg installed and on `PATH`, an additional check within the suite decodes the generated GIF and verifies two distinct frames. That check skips when FFmpeg is unavailable; it passed during this verification. FFmpeg is a test aid, not an extension runtime dependency.
- Syntax checks passed for the four modified application scripts, and `git diff --check` passed.

The initial eight regression tests failed against the pre-fix implementation and passed after the changes. Browser APIs and video seeking are simulated in the lifecycle tests; **live browser extension integration has not been verified** because Chromium and Firefox were unavailable in the test environment.

### Browser smoke test still needed

The extension currently declares Manifest V2; browser compatibility has not been revalidated as part of these fixes. In a browser that can load this extension, reload the extension and refresh Twitter/X tabs before testing. This also clears workers left behind by the previous implementation.

Check that repeated clicks during a download do not create extra copies; same-named, distinct media both finish; GIF/MP4 preferences work independently; and cancelled or failed downloads can be retried. Confirm GIF playback and that workers and resource usage settle after completion or failure.

## Git remotes

For development on this fork, the intended remote layout is:

```text
origin    git@github.com:coco-is-magik/TwitterMediaAssist.git
upstream  https://github.com/Flkalas/TwitterMediaAssist.git
```

`origin` is this fork's fetch/push destination. `upstream` points to the original project for reference and fetching upstream changes. Remote configuration is local to a clone; cloning this fork does not automatically add `upstream`.

## Privacy

The upstream README states that the extension processes Twitter pages locally, does not collect user data, and has no application server or database. This fork's download and cleanup changes add no telemetry or external service. Media retrieval still requires network requests to Twitter/X and its media hosts; local GIF conversion is not an offline-download guarantee. This statement is not a new independent privacy audit.

## Earlier upstream projects

- [Flkalas/TwitterVideoAssistChrome](https://github.com/Flkalas/TwitterVideoAssistChrome) — earlier Twitter Video Assist for Chrome project linked by upstream.
- [Flkalas/M2G](https://github.com/Flkalas/M2G) — additional earlier project linked by upstream, retained here for historical reference.

## License and attribution

MIT licensed. The original **Copyright (c) 2018 Flkalas** notice and license terms are preserved unchanged in the repository's `LICENSE` file.
