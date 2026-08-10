# LaunchDarkly AutoFactory

Every software factory is different. This repository is an opinionated reference
implementation for developing a software factory using **LaunchDarkly primitives**
alongside tools like **Claude Code, Cursor, and Sentry**.

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
    subgraph BUILD["Build"]
        direction TB
        B1["Configure the factory<br/>(Config Bridge)"]
        B2["Resolve runtime instructions<br/>(Agent Configs)<br/>(Tools)"]
        B3["Resolve orchestration topology<br/>(Agent Graphs)"]
        B4["Read production and code context<br/>(Observability and Code References)"]
        B5["Compose run context<br/>(Knowledge graph)"]
        B6["Execute agents safely<br/>(Graph walker and runners)<br/>(Sandbox tools and safety gates)"]
        B7["Create control and evidence<br/>(Feature Flags)<br/>(Metrics)"]
        B8["Evaluate implementation quality<br/>(Judges)"]
        B9["Capture release intent<br/>(Release manifest)"]
        B1 --> B2 --> B3 --> B4 --> B5 --> B6 --> B7 --> B8 --> B9
    end

    subgraph DEPLOY["Deploy"]
        direction TB
        D1["Build artifact<br/>(Existing CI)"]
        D2["Deploy code<br/>(Existing CD)"]
        D3["Keep new behavior off<br/>(Feature Flags)"]
        D4["Carry release contract<br/>(Release manifest)"]
        D5["Receive service and SHA<br/>(Beacon)"]
        D1 --> D2 --> D3 --> D4 --> D5
    end

    subgraph RELEASE["Release"]
        direction TB
        R1["Discover release contract<br/>(Beacon)<br/>(Release manifest)"]
        R2{"Resolve release intent<br/>(Beacon)"}
        R3["Select release policy<br/>(Guarded and Progressive Releases)"]
        R4["Control staged exposure<br/>(Feature Flags)<br/>(Guarded and Progressive Releases)"]
        R5["Evaluate production evidence<br/>(Metrics)<br/>(Observability and Code References)"]
        R6{"Decide release outcome<br/>(Guarded and Progressive Releases)"}
        R7["Complete exposure<br/>(Feature Flags)"]
        R8["Hold release<br/>(Beacon)"]
        R9["Stop rollout<br/>(Feature Flags)"]
        R10["Roll back automatically<br/>(Guarded and Progressive Releases)"]
        R1 --> R2
        R2 -->|"Release"| R3
        R2 -->|"Hold"| R8
        R3 --> R4 --> R5 --> R6
        R6 --> R7
        R6 --> R9
        R6 --> R10
    end

    BUILD -->|"Code and contract"| DEPLOY
    DEPLOY -->|"Deploy succeeded"| RELEASE

    subgraph LEGEND["Legend"]
        direction TB
        L1["LaunchDarkly primitive"]
        L2["AutoFactory component"]
        L3["Existing CI/CD"]
    end

    classDef ld fill:#A34FDE,color:#FFFFFF,stroke:#713099,stroke-width:2px
    classDef autofactory fill:#218739,color:#FFFFFF,stroke:#155F28,stroke-width:2px
    classDef existing fill:#FFFFFF,color:#191919,stroke:#8C8C8C,stroke-width:1px

    class B2,B3,B4,B7,B8,D3,R3,R4,R5,R6,R7,R9,R10 ld
    class B1,B5,B6,B9,D4,D5,R1,R2,R8 autofactory
    class D1,D2 existing
    class L1 ld
    class L2 autofactory
    class L3 existing
```

## The flow

| Stage | Job | Output |
|---|---|---|
| **Build** | Make the change release-ready. Preserve the control path, define success and failure, and capture intent. | Flagged code, metrics, tests, review, release manifest |
| **Deploy** | Make the change available without exposing it. Keep the existing delivery pipeline. | Running code, behavior still off, deploy notification |
| **Release** | Control customer exposure using intent and production evidence. | Complete, hold, stop, or roll back |

The goal is not code throughput or deployment frequency in isolation. It is reliable flow
from idea to customer value, with control where uncertainty is highest.

## LaunchDarkly Primitives

| Primitive | Used in | What it contributes |
|---|---|---|
| **Agent Configs** | **Build** | Runtime-defined instructions, models, parameters, variations, targeting, and monitoring |
| **Tools** | **Build** | Reusable tool descriptions and schemas attached to agent variations |
| **Agent Graphs** | **Build** | Agent topology and handoff metadata resolved at runtime |
| **Judges** | **Build** | Sampled quality scores for implementation and metrics changes |
| **Feature Flags** | **Build, Deploy, Release** | Multivariate variations, targeting, prerequisites, and operational controls |
| **Observability and Code References** | **Build, Release** | LLM traces, service dependencies, telemetry coverage, and flag wrap points |
| **Metrics** | **Build, Release** | Custom, trace-based, and Sentry-backed measures tied to flag exposure |
| **Guarded and Progressive Releases** | **Release** | Release policies, staged exposure, production guardrails, and automatic rollback |

## What AutoFactory Adds

| Component | Used in | What it adds |
|---|---|---|
| **Config Bridge** | **Build** | Provisioning and synchronization for Agent Configs, Tools, Agent Graphs, flags, and metrics |
| **Graph walker and runners** | **Build** | Agent traversal, model-provider execution, routing, approvals, and handoffs |
| **Sandbox tools and safety gates** | **Build** | Code edits, flag and metric creation, test execution, capability limits, and evidence checks |
| **Knowledge graph** | **Build** | Per-run composition of observability traces, code references, and repository context |
| **Release manifest** | **Build, Deploy, Release** | A versioned contract carrying release plan, human intent, metrics, dependencies, and scope through deployment |
| **Beacon** | **Deploy, Release** | Deploy notification handling, manifest discovery, intent enforcement, release triggering, and outcome monitoring |

Claude Code and Cursor provide execution surfaces. Sentry provides external error telemetry
and Seer Autofix. They integrate with this reference implementation; LaunchDarkly provides
the primitives above.

## Go deeper

- [Setup and reference](REFERENCE.md)
- [Factory design](docs/design-partners-factory.md)
- [Detailed pipeline](docs/pipeline-overview.html)
- [Build orchestration](packages/shared/README.md)
- [Release orchestration](packages/beacon/README.md)
- [Architecture decisions](docs/adr/)
