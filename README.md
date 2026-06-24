# Browser Transcriber + Diarization — GitHub Pages build

This is the GitHub Pages-safe build of the browser-only live transcription prototype.

It is a static application: no backend, no build step, no API key, and no server storage.

## Deploy to GitHub Pages

1. Create a repository, for example `browser-transcriber`.
2. Copy these files into the repository root:
   - `.nojekyll`
   - `index.html`
   - `app.js`
   - `styles.css`
   - `manifest.json`
   - `sw.js`
   - optional: `text-assembly-smoke-test.mjs`
3. Commit and push.
4. In GitHub, go to **Settings → Pages**.
5. Set the source to the branch/folder you pushed.
6. Open the generated `https://<user>.github.io/<repo>/` URL in current desktop Chrome.

## HTTPS is required

The app uses `getUserMedia()` and `AudioWorklet`, both of which require a secure context in normal browser deployment. GitHub Pages supports HTTPS, and you should enable **Enforce HTTPS**, especially on custom domains.

## Browser support

Use desktop Chrome or Chromium-based Edge. Web Speech recognition is not a consistent cross-browser API. Firefox is not a target for this build.

## Service worker note

This build intentionally does **not** register a service worker. The included `sw.js` is only a cleanup file for anyone who previously tested older builds that registered a cache. It clears old `browser-transcriber-*` caches and unregisters itself.

## Local test

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

For the text assembly smoke test:

```bash
node text-assembly-smoke-test.mjs
```
