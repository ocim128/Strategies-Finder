# Deploying to Vercel

This Vite app can be deployed to Vercel from the repository root that contains this `package.json`.

## Deployment Steps

1.  **Push to GitHub/GitLab/Bitbucket**: Ensure your code is pushed to a repository connected to your Vercel account.
2.  **Import Project in Vercel**:
    *   Go to your Vercel dashboard and click "Add New... > Project".
    *   Select your repository.
3.  **Configure Project Settings**:
    *   **Root Directory**: Use the directory containing this `package.json`.
    *   **Framework Preset**: Select `Vite`.
    *   **Build Command**: `npm run build` (This should auto-detect, but verify).
    *   **Output Directory**: `dist` (This should also auto-detect).
    *   **Install Command**: `npm install` (Standard).
    *   **Environment Variables**:
        *   Add `SITE_PASSWORD` in the `Production` environment.
        *   Do not use a `VITE_*` variable for this. `VITE_*` values are exposed to the browser bundle.
4.  **Deploy**: Click "Deploy".

## Password Protection

This repo now includes a root `middleware.ts` for Vercel.

Behavior:
- `Production` deployments are password-protected.
- `Preview` deployments stay open.
- Local development on `localhost` or `127.0.0.1` stays open.

How it works:
- Unauthenticated visitors are shown a small password form served directly by the middleware.
- Successful auth sets an `HttpOnly` cookie and redirects back to the requested path.
- If `SITE_PASSWORD` is missing in production, the site fails closed with a `503` response instead of exposing the app publicly.

## Troubleshooting

*   **Missing Dependencies**: If the build fails due to missing modules, ensure `package.json` in this directory contains all necessary dependencies. We have explicitly added `vite` and `typescript` to ensure the build environment is self-contained.
*   **Path Issues**: If the deployed site loads but assets (scripts/styles) are missing (404), check the `base` configuration in `vite.config.ts`. Currently, it assumes deployment at the domain root (`/`).
*   **Site is always locked**: Verify `SITE_PASSWORD` is set in Vercel `Production` env vars, then redeploy.
*   **Local dev asks for a password**: This should not happen on `localhost` or `127.0.0.1`. If it does, check whether you are proxying through a non-local hostname.

## Local Testing

You can simulate the build locally by running:

```bash
npm install
npm run build
npx vite preview
```
