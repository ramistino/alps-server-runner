# ALPS Recovery Patch v1.1

Safe-boot recovery runner. This patch keeps the Render web service online even if Playwright/Chromium cannot launch, exposes `/runner/health` and `/runner/recovery`, records the page launch error, and retries with a clean Chromium profile. It does not change ALPS strategy logic.
