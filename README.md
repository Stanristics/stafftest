# Shift Planner for pick and inbound

A browser tool that builds a weekly shift plan for an online grocery picking store.
Inputs: orders per day, items per order, seconds per item, inbound work, time windows, and staff contracts and availability.
Output: a roster, coverage charts, and the chance that picking finishes on time.

Everything runs in the browser (HiGHS solver compiled to WebAssembly). No server, no data leaves the computer.

## How it works
1. **Workload.** Picking hours per day = orders x items x seconds per item / productive share of paid time.
   The plan covers the workload not exceeded on the chosen share of days (default 95%), found by Monte Carlo simulation
   (random order counts, order sizes of 1 to 170 items with the entered mean, and picking speed between the fastest and slowest setting).
2. **Optimisation.** A mixed-integer program chooses one shift (or none) per person per day.
   At every half hour, the capacity remaining must cover all work released from then on; minimum floor staffing and
   inbound-qualified staffing are enforced; contract maximum hours, days and availability are hard limits.
   Objective: fewest paid hours, penalties for unmet work and for people below contract minimum, and a small push towards fair Saturday rotation.
3. **Check.** An independent simulation (different random seed) estimates the chance the finished plan holds.

## Files
- `index.html`: the app. `planner.js`: demand model, MILP builder, simulation. `solver-worker.js`: runs the solver in a Web Worker.
- `highs/`: HiGHS WebAssembly build (MIT licence, from the `highs` npm package 1.15.4).

## Run it
Serve the folder over http (the solver loads a .wasm file, which browsers block from file://):
```bash
python3 -m http.server 8000     # then open http://localhost:8000
```
To publish: drag the folder onto app.netlify.com/drop.

## Assumptions to replace with real figures
Inbound labour hours and window, contract hours and maximum days per person, the productive share of paid time (85%),
and the order-count variation (8%). Labour-law and works-council rules are not checked.
