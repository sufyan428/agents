## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- The problem being solved. -->

## How it was tested

<!-- Be specific. "Ran against the simulator with an interface-flap injection"
     beats "tested locally". Say if you tested against real hardware. -->

## Checklist

- [ ] Scoped to one logical change
- [ ] Tests added or updated for behaviour a test could catch
- [ ] `npm test` passes in every agent I touched
- [ ] No `.env`, key, log file, or `data/` content committed
- [ ] No new stub returns `{ success: true }` for work it did not do
- [ ] No AI API call added to agents 1-6
- [ ] No new path writes to a network device without explicit human confirmation
