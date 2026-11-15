# Eval-View Dashboard

The Eval-View Dashboard lets you visualize evaluation results from the Modern Web Guidance eval harness.

Open the dashboard on this machine with `gd dashboard` or `pnpm dashboard`, via `server.js`. This fork does not deploy GitHub Pages, sign in with Google, or read a cloud bucket. Evaluation files stay in the local checkout.

## Local Development

To run the dashboard locally and see local results (run from the root `modern-web-guidance-src` directory):

```bash
pnpm dashboard
```

### Parity Testing
To ensure your changes will work on the static deployment host, you can run the dashboard in a "Static" mode that serves files via `statikk` to mimic static deployment structure:

```bash
# From the project root directory
STATIC=true gd dashboard
```

## Deploying Changes

This fork does not deploy the dashboard. `pnpm deploy:dashboard` only builds the local bundle. Review it with `pnpm dashboard`.
