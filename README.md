# LaunchDarkly AutoFactory

An opinionated framework for a software factory built on **LaunchDarkly Release
Primitives**.

## Why

Software factories have optimized build and deploy. AI accelerates planning, coding,
testing, and review. CI/CD makes production deployment routine. Release is still often an
implicit step, even though it is where customers and risk enter the system.

Deployment proves code is running. Release determines whether customers should receive the
change, whether it works for them, and whether it should keep rolling out.

> **A software factory is incomplete until it can release what it builds, measure the
> outcome, and respond safely.**

## The complete factory

```mermaid
flowchart LR
    subgraph BUILD["BUILD: make it ready"]
        direction TB
        B1["Understand<br/>change • scope • risk"]
        B2["Prepare<br/>flag • control path"]
        B3["Prove<br/>metrics • tests • review"]
        B4[["Release manifest<br/>intent • guardrails"]]
        B1 --> B2 --> B3 --> B4
    end

    subgraph DEPLOY["DEPLOY: make it available"]
        direction TB
        D1["Build artifact"]
        D2["Existing CD deploys"]
        D3["New behavior stays off"]
        D4[["Notify<br/>service • SHA"]]
        D1 --> D2 --> D3 --> D4
    end

    subgraph RELEASE["RELEASE: make it real"]
        direction TB
        R1["Discover manifest"]
        R2["Resolve<br/>intent • policy • dependencies"]
        R3["Roll out<br/>audience • stages"]
        R4["Measure<br/>production guardrails"]
        R5{"Outcome"}
        R6["Complete"]
        R7["Hold / stop"]
        R8["Roll back"]
        R1 --> R2 --> R3 --> R4 --> R5
        R5 --> R6
        R5 --> R7
        R5 --> R8
    end

    B4 -->|"code + contract"| D1
    D4 -->|"deploy succeeded"| R1
```

## The opinion

| Stage | Job | Output |
|---|---|---|
| **Build** | Make the change release-ready. Preserve the control path, define success and failure, and capture intent. | Flagged code, metrics, tests, review, release manifest |
| **Deploy** | Make the change available without exposing it. Keep the existing delivery pipeline. | Running code, behavior still off, deploy notification |
| **Release** | Control customer exposure using intent and production evidence. | Complete, hold, stop, or roll back |

The goal is not code throughput or deployment frequency in isolation. It is reliable flow
from idea to customer value, with control where uncertainty is highest.

## How the framework works

- A configurable AI-agent graph prepares each change for release.
- Any CD system deploys the code while new behavior remains off.
- Beacon translates a successful deploy into guarded or progressive LaunchDarkly releases.
- `.release-flags/` carries the versioned contract from build to release.

The reference implementation supports GitHub, editor, Cursor, and CLI entry points. Build
and release run end to end against a live demo repository.

## Go deeper

- [Setup and reference](REFERENCE.md)
- [Factory design](docs/design-partners-factory.md)
- [Detailed pipeline](docs/pipeline-overview.html)
- [Build orchestration](packages/shared/README.md)
- [Release orchestration](packages/beacon/README.md)
- [Architecture decisions](docs/adr/)
