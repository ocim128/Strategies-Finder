# Deploying to Vercel

This directory (`debug/playground/test-chart.d`) is now configured to be deployable to Vercel.

## Deployment Steps

1.  **Push to GitHub/GitLab/Bitbucket**: Ensure your code is pushed to a repository connected to your Vercel account.
2.  **Import Project in Vercel**:
    *   Go to your Vercel dashboard and click "Add New... > Project".
    *   Select your repository.
3.  **Configure Project Settings**:
    *   **Root Directory**: Click "Edit" next to Root Directory and select `debug/playground/test-chart.d`.
    *   **Framework Preset**: Select `Vite`.
    *   **Build Command**: `npm run build` (This should auto-detect, but verify).
    *   **Output Directory**: `dist` (This should also auto-detect).
    *   **Install Command**: `npm install` (Standard).
4.  **Deploy**: Click "Deploy".

## Troubleshooting

*   **Missing Dependencies**: If the build fails due to missing modules, ensure `package.json` in this directory contains all necessary dependencies. We have explicitly added `vite` and `typescript` to ensure the build environment is self-contained.
*   **Path Issues**: If the deployed site loads but assets (scripts/styles) are missing (404), check the `base` configuration in `vite.config.ts`. Currently, it assumes deployment at the domain root (`/`).

## Local Testing

You can simulate the build locally by running:

```bash
cd debug/playground/test-chart.d
npm install
npm run build
npx vite preview
```
