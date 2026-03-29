# PR-09 Screenshot Analytics (PT1 advanced synthetic scenario)

Source image was produced by Playwright test case `PR-09 inspector controls screenshot artifact` and analyzed visually (not committed as binary).

## Verified UI state

- Header shows **Project Data** and text indicating **PT1** inspection mode.
- Stats badges are visible and populated (`Batches: 2`, `Parts: 3`, `Passed: 1`, `Rejected: 1`).
- Left panel shows part list with two visible parts in filtered view and status pills (`Reject Pending`, `In Review`).
- Selected part title is **Housing Adv 1** and row highlight is present.
- Review actions are visible: `Set In Review`, `Mark Pass ✓`, `Flag Reject`.

## Inspector control analytics

- **Modalities** section is visible with three checkbox options: `visual`, `infrared`, `uv`.
  - `visual` appears checked.
- **View quick switch** section contains six buttons: `FRONT`, `BACK`, `LEFT`, `RIGHT`, `TOP`, `BOTTOM`.
- **Image visibility** control is visible and in `Hide image` state.
- **Measurements** section shows:
  - input fields (`label`, `value`),
  - `Save measurement` button,
  - saved measurement list entry: `qa-length: 18.25mm (visual • front)`.

## PT1 view-board analytics

- Six view tiles are visible (FRONT/BACK/LEFT/RIGHT/TOP/BOTTOM).
- FRONT tile is highlighted as active selection.
- Mapped-image labels appear for expected seeded views:
  - `Mapped: housing-adv-front.png` on FRONT,
  - `Mapped: housing-adv-top.png` on TOP.
- Remaining view tiles correctly show `No image mapped`.

## Verdict

The screenshot reflects the expected PR-09 milestone-1 PT1 state: common inspector controls are present, measurement capture renders correctly, and PT1 view-board selection/mapping behavior is visible and coherent.
