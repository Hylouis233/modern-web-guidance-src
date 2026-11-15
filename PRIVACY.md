# Privacy

This fork keeps evaluation data, search queries, and guide text on your machine.

Removed network paths:

- CLI usage telemetry to `play.googleapis.com` (Clearcut). It cannot be turned back on from this tree.
- Uploads and downloads of eval suites through Google Cloud Storage.
- The dashboard reverse proxy and Google sign-in script.
- `npm publish`, GitHub Pages deploys, and the nightly email to `@google.com`.
- Gemini calls that would upload guide text, diffs, judgments, or embeddings. Local caches are still used. A missing cache fails closed.

What stays:

- The guide corpus. Those documents teach web platform features. Some of them mention analytics or browser APIs. They are not this repository uploading your project.
- `node bin/gd.ts` for local search, retrieve, and legacy scan.
- `pnpm dashboard` for a local evaluation view. It does not publish pages.

Do not run `npx modern-web-guidance@latest`. That installs Google's package.

Original project: https://github.com/GoogleChrome/modern-web-guidance-src
This fork: https://github.com/Hylouis233/modern-web-guidance-src
