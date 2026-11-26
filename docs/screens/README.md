# Screens

Screenshots the system map shows at the journey step where each happens. The images are the README's own, in `media/`; nothing is copied here.

- `screens.json`: each screen, its caption, and the journey steps that show it (`step` counts from 0).
- `manifest.json`: the image file, its size, and the commit it was taken at. The map marks a screen *may be out of date* when one of its `source` files changed after that commit.

When you retake a screenshot in `media/`, update its `capturedAt` here.
