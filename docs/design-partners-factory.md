# How the factory is designed

AutoFactory is an opinionated reference implementation for safe, agentic software delivery.
It shows how a change can move from an agent-built pull request to a measured customer
release without treating deployment as the finish line.

## Why separate deploy from release

Deployment makes code available. Release exposes behavior to customers.

AutoFactory deploys new behavior behind a flag that is off. LaunchDarkly then controls
exposure, measures the result, and decides whether the rollout should continue. This keeps
the existing delivery pipeline while adding control where uncertainty is highest.

## What the factory contains

The design has three layers:

| Layer | Responsibility |
|---|---|
| **LaunchDarkly primitives** | Configure agents, route work, evaluate quality, control behavior, measure outcomes, and run guarded releases |
| **AutoFactory components** | Execute the graph, enforce safety, compose context, carry release intent, and connect deploy events to releases |
| **Existing delivery infrastructure** | Manage source, run CI checks, publish artifacts, deploy code, and operate services |

LaunchDarkly holds the control plane. Agent Configs define instructions and models. Tools
define callable capabilities. Agent Graphs define routing and handoffs. Judges measure
output quality. Feature Flags, Metrics, Observability, and Guarded Releases control the
customer-facing outcome.

AutoFactory supplies the connective tissue. Its runners execute the graph, sandbox tools
limit agent actions, the knowledge graph adds production and repository context, the
release manifest carries intent, and Beacon translates a successful deploy into a release.

## How a change moves through the factory

### 1. Build a release-ready change

The factory resolves a six-role graph at run time:

1. **Research and planning** classifies the change, assesses risk, and starts the manifest.
2. **Intent stewardship** turns human release notes into structured intent.
3. **Flag implementation** creates the flag off and preserves the control path.
4. **Metrics authoring** creates measurable error, latency, and business signals.
5. **Testing** verifies the new and existing behavior.
6. **Review** evaluates the complete diff without write access.

Changes that do not need a flag can stop after classification. Repeated runs reuse existing
resources instead of duplicating them.

### 2. Deploy without exposing behavior

The existing CI/CD system validates, packages, and deploys the code. The flag remains off.
The `.release-flags/*.json` manifest travels with the deployed commit and records:

- the flag and application scope
- proposed metrics and rollout mechanics
- human intent such as hold, date, segment, or prerequisites

Agent runs may update the proposed `releasePlan`. They cannot overwrite human-owned
`releaseIntent`.

### 3. Release with production evidence

After deploy, Beacon:

1. receives the service and deployed SHA
2. discovers new manifests in that commit range
3. honors human intent before automation
4. starts the selected LaunchDarkly release
5. observes the release until it completes, reverts, or stops

LaunchDarkly owns traffic progression, metric evaluation, and automatic rollback. Beacon
is a thin adapter to those primitives, not a second rollout engine.

## How the design stays safe

- New flags start off in every environment.
- The factory project defines agents; the app project receives application flags and metrics.
- Each graph edge grants only the capabilities required by the next agent.
- Runtime code sets the maximum write permissions. Configuration can narrow them, not widen them.
- Approval policy pauses execution before a gated action.
- Unknown risk fails closed.
- Tools report side effects. Agent claims do not establish that a write succeeded.
- Judges score verified diffs, not agent summaries.

## How the factory learns

Every agent run records duration, tokens, tools, and outcome. OpenTelemetry spans expose the
full execution path. Judges add a quality score based on the actual code change.

This makes changes to models, prompts, tools, and context measurable. A variation should
earn its place by improving quality, cost, or speed.

Optional context can include:

- service dependencies from LaunchDarkly Observability
- flag locations from Code References
- a repository-owned service registry
- related repositories accessed through GitHub
- Sentry errors and AI-agent telemetry

Missing context remains visible as unknown. It does not become evidence of low risk.

## What you can replace

Every software factory is different. This implementation exposes four seams:

- **Entry point:** GitHub Actions, Claude Code, Cursor, or another environment that can run the graph.
- **Model provider:** Anthropic, Cursor, Vega, or another `AgentRunner` implementation.
- **Delivery system:** any CI/CD platform that can deploy code and send a webhook.
- **Context:** the repositories, telemetry, tools, and instructions available to each agent.

The contract between Build and Release is the release manifest. The contract between Deploy
and Beacon is a small webhook. Those boundaries keep the implementation portable.

## Current limitations

- AutoFactory creates string multivariate flags. Existing boolean flags require a child flag for later iterations.
- Beacon uses a local file for deploy state and should run as one instance with persistent storage.
- Full-stack release coordination has less production exercise than single-service releases.
- Trace-based metrics require application telemetry to reach LaunchDarkly and include flag evaluations.

## Next steps

- [Set up the reference implementation](../REFERENCE.md)
- [Inspect the detailed pipeline](pipeline-overview.html)
- [Read the architecture decisions](adr/)
