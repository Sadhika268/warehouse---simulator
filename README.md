# Warehouse Live Simulator

A browser-based, live (animated) simulator of a manual warehouse: flow, stock capacity, dwell and cycle time, and people required.
It runs entirely in your browser - no server, no installation, nothing is sent over the network.

**Live simulator:** https://YOUR-GITHUB-USERNAME.github.io/YOUR-REPOSITORY-NAME/  *(replace with your link after enabling GitHub Pages - see below)*

## What it does
- Simulates inbound (east side) and outbound (west side) pallet flows hour by hour from an editable 24-hour demand profile.
- F7 putaway, F9 outbound picking and F7-REPL replenishment picking share one capacity pool (FIFO, ties F7 then F9 then F7-REPL); every other flow has its own capacity.
- Define each process by people x productivity, or by capacity (the model then gives the people needed).
- Shows stock per area (S4, S6, S8, S10, S12) against capacity, backlog, additional dwell, cycle times, and people needed per hour.
- Tabs: **Live** (animation, KPIs, charts), **Snapshot** (static stock and flow at a chosen time), **Inputs**, **Results** (verdicts, area report, hourly dashboard with red highlighting above a threshold, people, dwell), **Ledgers** (audit trail, CSV), **Scenarios** (save, compare, sensitivity), **Layout**.

## Process flow
```mermaid
flowchart LR
  subgraph EAST["EAST - INBOUND"]
    F1["F1 Truck check"] --> F2["F2 Unloading"] --> F3["F3 Pallet receiving"] --> S4[("S4 Inbound staging")] --> F5["F5 Move S4 to S6"] --> S6[("S6 Inbound P and D")] --> F7["F7 Putaway"]
  end
  F7 --> S8[("S8 Main storage")]
  S8 --> F9["F9 Outbound picking"]
  subgraph WEST["WEST - OUTBOUND"]
    F9 --> S10[("S10 Outbound P and D")] --> F11["F11 Move S10 to S12"] --> S12[("S12 Outbound staging")] --> F13["F13 Truck loading"] --> F14["F14 Dispatch"]
  end
  S8 --> F7R["F7-REPL Replenishment picking"]
  F7R -- "50%" --> S6
  F7R -- "50%" --> S10
  S6 --> F17["F17 Manual EPT"]
  S10 --> F17
  F17 --> S11[("S11 Final replenishment")]
  POOL{{"Shared pool F7 + F9 + F7-REPL: capacity in pallets per hour, FIFO, ties F7 then F9 then F7-REPL"}}
  POOL -.-> F7
  POOL -.-> F9
  POOL -.-> F7R
```

## How to use
1. Open the live link above (Edge or Chrome).
2. Press **Start** on the Live tab (or **Run to end**), then open **Results**.
3. Change values on the **Inputs** tab to test other cases; use **Scenarios** to save and compare them.
Saved scenarios stay in your own browser.

## Files
| File | Purpose |
|---|---|
| index.html | The complete simulator in one file (this is what GitHub Pages serves) |
| src/ | The same program as separate files: index.html, engine.js (simulation), pp.js (screens), layout.png |
| docs/process-flow.mmd | Mermaid source of the process flow diagram |

To run locally, download index.html and open it in a browser.

## Status
Baseline reference results and the full specification are in the Business Requirements Document (version 2.1), which is kept outside this repository.