# Original project brief

This page records the assumptions that started AutoFactory. It is historical context, not
current setup documentation.

## Why the project started

The original goal was to explore safe, increasingly autonomous software delivery with
LaunchDarkly as the production control layer. The project needed to be:

- simple for design partners to install
- modular enough to change with feedback
- safe for a public repository
- explicit about where humans retain control

## What the first design proposed

The initial design separated the factory into three stages:

1. **Build:** agents create flags, metrics, instrumentation, tests, and a review verdict.
2. **Release:** a deploy signal starts a measured LaunchDarkly release.
3. **Cleanup:** mature LaunchDarkly workflows remove flags after a completed release.

The first Build graph had four broad roles: research, implementation, testing, and review.
The first Release design depended on internal deployment tooling and an unnamed public
orchestrator.

## How the implementation evolved

The current reference implementation keeps the original separation between deployment and
release, but makes the boundaries portable:

- six focused agent roles replace the four broad roles
- Agent Configs, Tools, Agent Graphs, and Judges define agent behavior
- a provider-neutral runner supports several execution surfaces
- a release manifest carries agent proposals and human intent
- Beacon accepts a small, provider-neutral deploy webhook
- LaunchDarkly Guarded and Progressive Releases own rollout and rollback

These changes preserve the original principle: automate the work while keeping release
control explicit and measurable.

## Continue with the current documentation

- [Why the factory exists](../README.md)
- [How the factory is designed](design-partners-factory.md)
- [How to set it up](../REFERENCE.md)
- [Why specific decisions were made](adr/)
